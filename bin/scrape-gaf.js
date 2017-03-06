#!/usr/bin/env node

var fs = require('fs')
var readline = require('readline')
var Promise = require('bluebird')
var exec = Promise.promisify (require('child_process').exec)

var converters = require('../wtfgenes/lib/converters')
var gaf2json = converters.gaf2json
var obo2json = converters.obo2json

var go_url_prefix = "http://geneontology.org/ontology/"
var gaf_url_prefix = "http://geneontology.org/gene-associations/"

var go_url_suffix = "go-basic.obo"
var gaf_metadata_url_suffix = "go_annotation_metadata.all.js"

// not doing the uniprot mapping as it's too big; leaving it in, but commented out, for now
// var uniprot_mapping_url = "ftp://ftp.uniprot.org/pub/databases/uniprot/current_release/knowledgebase/idmapping/idmapping_selected.tab.gz"

var metadata_url = gaf_url_prefix + gaf_metadata_url_suffix

function skip_id (id) {
  return /^goa_uniprot_all/.test(id) || /_complex$/.test(id) || /_rna$/.test(id) || id === 'jcvi'
}

var example_terms = ['GO:0006298',  // mismatch repair
                     'GO:0000027']  // ribosomal large subunit assembly

var deploy_dir = 'web'
var gaf_subdir = 'gaf'
var go_subdir = 'go'

var download_dir = 'download'

var go_path = go_subdir + '/' + go_url_suffix.replace('.obo','.json')

// set up deploy directory
var init_promise = fs.existsSync(deploy_dir)
    ? Promise.resolve(true)
    : (exec("cp -r wtfgenes/web " + deploy_dir)
       .then (() => exec("cd " + deploy_dir + "; make"))
       .then (() => exec("mkdir -p " + deploy_dir + '/' + gaf_subdir))
       .then (() => exec("mkdir -p " + deploy_dir + '/' + go_subdir))
       .then (() => exec("mkdir -p " + download_dir))
       .then (() => console.log("initialized " + deploy_dir + " and " + download_dir)))

// wrappers to download-and-cache
var readFile = Promise.promisify (fs.readFile)
function download_filename (url) {
  var filename = url.replace(/^.*\//,'')
  var local_path = download_dir + '/' + filename
  var local_unzipped = local_path.replace (/\.gz$/, '')
  var curl_promise = fs.existsSync (local_path)
      ? Promise.resolve(true)
      : (exec ("cd " + download_dir + "; curl -O " + url)
         .then (() => {
           if (url.match(/\.gz$/))
             return exec ("cd " + download_dir + "; gunzip --keep " + filename)
           else
             return true
         }))
  return curl_promise
    .then (() => local_unzipped)
}

function download_data (url) {
  return download_filename (url)
    .then ((filename) => readFile (filename))
    .then ((buffer) => buffer.toString())
}

// download GO
var term_name = {}
init_promise
  .then (() => download_data (go_url_prefix + go_url_suffix))
  .then (function (obo) {
    console.log ("processing " + go_url_suffix)
    var go_json = obo2json ({ obo: obo,
			      compress: true,
			      includeTermInfo: true })
    fs.writeFileSync (deploy_dir + '/' + go_path, JSON.stringify (go_json))
    go_json.termParents.forEach (function (term_parents, n) {
      term_name[term_parents[0]] = go_json.termInfo[n]
    })
  })
// download UniProt mapping
// commented out because it's just too big
//  .then (() => download_filename (uniprot_mapping_url))
//  .then ((uniprot_mapping_filename) => download_data (metadata_url)
  .then (() => download_data (metadata_url)
         // download GAF metadata
         .then (function (html) {
           eval (html)  // defines global_go_annotation_metadata
           return global_go_annotation_metadata
         }).then (function (metadata) {
           var resources = metadata.resources
           return Promise.all
           (resources
            .filter (resource => !skip_id(resource.id))
            .map (function (resource) {
              // download each GAF file
              var gaf_filename = resource.gaf_filename
              return download_data (gaf_url_prefix + gaf_filename)
              // commented out & replaced with simple gaf2json to avoid huge hit of processing uniprot ID map
              //                .then ((gaf_file) => get_aliases (gaf_filename, gaf_file, uniprot_mapping_filename))
                .then ((gaf_file) => quick_gaf2json (gaf_filename, gaf_file))
                .then (function (gaf_json) {
                  // examples
                  var examples = example_terms.map (function (term) {
                    var genes = gaf_json.idAliasTerm.filter (function (id_alias_term) {
                      var has_term = false
                      id_alias_term[2].forEach (function (gterm) {
                        has_term = has_term || term === gterm
                      })
                      return has_term
                    }).map (function (id_alias_term) { return id_alias_term[0] })
                    return { name: term_name[term], genes: genes }
                  }).filter (function (example) { return example.genes.length > 0 })
                  // write
                  var gaf_path = gaf_subdir + '/' + resource.id + '.json'
                  fs.writeFileSync (deploy_dir + '/' + gaf_path, JSON.stringify (gaf_json))
                  return {
                    name: resource.label,
                    ontologies: [
                      { name: "Gene Ontology (basic)",
                        ontology: go_path,
                        assocs: gaf_path,
                        examples: examples }
                    ]
                  }
                })
            }))
         }).then (function (organisms) {
           organisms = organisms.sort (function (a, b) { return a.name < b.name ? -1 : +1 })
           fs.writeFileSync (deploy_dir + '/datasets.json', JSON.stringify ({ organisms }))
           console.log ("done")
         })
        )

function quick_gaf2json (gaf_filename, gaf_file) {
  console.log ("processing " + gaf_filename)
  return gaf2json ({ gaf: gaf_file })
}

// this function no longer used since uniprot mapping is commented out
function get_aliases (gaf_filename, gaf_file, uniprot_mapping_filename) {
  return new Promise (function (resolve, reject) {
    console.log ("processing " + gaf_filename)
    var gaf_json_no_aliases = gaf2json ({ gaf: gaf_file })
    // find all gene symbols
    var is_symbol = {}
    gaf_json_no_aliases.idAliasTerm.forEach (function (id_alias_term) {
      is_symbol[id_alias_term[0]] = true
      id_alias_term[1].forEach (function (alias) { is_symbol[alias] = true })
    })
    // scan through Uniprot ID map for aliases
    var alias = []
    var line_reader = readline.createInterface({
      input: require('fs').createReadStream(uniprot_mapping_filename)
    })
    var re = /^(.*?) /;
    line_reader.on ('line', function (line) {
      var match = re.exec (line)
      if (match && is_symbol[match[1]])
        alias.push (line)
    })
    line_reader.on ('close', function() {
      console.log ("finished " + gaf_filename + " (" + alias.length + " aliases)")
      var aliases = alias.join('')
      var gaf_json = gaf2json ({ aliases: aliases, gaf: gaf_file })
      resolve (gaf_json)
    })
  })
}

