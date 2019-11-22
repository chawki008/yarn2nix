#!/usr/bin/env node
"use strict";

const crypto = require('crypto');
const fs = require("fs");
const https = require("https");
const path = require("path");
const util = require("util");

const lockfile = require("@yarnpkg/lockfile")
const docopt = require("docopt").docopt;

////////////////////////////////////////////////////////////////////////////////

const USAGE = `
Usage: yarn2nix [options]

Options:
  -h --help        Shows this help.
  --no-nix         Hide the nix output
  --no-patch       Don't patch the lockfile if hashes are missing
  --lockfile=FILE  Specify path to the lockfile [default: ./yarn.lock].
  --path TEXT      Absolute path of local dependencies
`

const HEAD = `
{fetchurl, linkFarm}: rec {
  offline_cache = linkFarm "offline" packages;
`.trim();

const remoteToString = function (remote) {
  return `
    {
      name = "${remote.file_name}";
      path = fetchurl {
        name = "${remote.drv_name}";
        url  = "${remote.url}";
        sha1 = "${remote.sha1}";
      };
    }`;
}

const localToString = function (local) {
  return `
    {
      name = "${local.name}";
      path = "${local.path}";
    }`;
}

const arrayToString = function (elements) {
  return `[
    ${elements.join("\n")}
  ]`;
}
const is_type = function (url) {
  return url.includes("@types");
}
const is_cypres = function (url) {
  return url.includes("@cypress");
}

////////////////////////////////////////////////////////////////////////////////

function generateNix(lockedDependencies, local_deps_path, workspaces) {
  let found = {};

  console.log(HEAD)
  const dirs = p => fs.readdirSync(p).filter(f => fs.statSync(path.join(p, f)).isDirectory())

  let localPackages = [];
  for (let i in workspaces) {
    if (Array.isArray(workspaces[i])) {
      let subWorkspaces = workspaces[i];
      for (let k in subWorkspaces) {
        // console.log("Workspaces");
        // console.log(Array.isArray(subWorkspaces[k]));
        // console.log(Array.isArray(subWorkspaces));
        // console.log(subWorkspaces[k].slice(-1));
        // console.log("Workspaces");
        if (subWorkspaces[k].slice(-1) === "*") {
          let subLocalDeps = dirs(local_deps_path + '/' +subWorkspaces[k].slice(0, -2));
          for (let j in subLocalDeps) {
            localPackages.push({
              name: subWorkspaces[k].slice(0, -1) + subLocalDeps[j],
              path: local_deps_path ? local_deps_path + '/' + subWorkspaces[k].slice(0, -1) + subLocalDeps[j] : path.resolve('./' + subLocalDeps[j])
            })
          }
        }
        else {
          localPackages.push({
            name: subWorkspaces[k],
            path: local_deps_path ? local_deps_path + '/' + subWorkspaces[i] : path.resolve('./' + subWorkspaces[i])
          })
        }
      }
    }
    else {
      if (workspaces[i].slice(-1) === "*") {
        let subLocalDeps = dirs(workspaces[i]);
        for (let j in subLocalDeps) {
          localPackages.push({
            name: subLocalDeps[j],
            path: local_deps_path ? local_deps_path + '/' + workspaces[i].slice(0, -1) + subLocalDeps[j] : path.resolve('./' + subLocalDeps[j])
          })
        }
      }
      else {
        localPackages.push({
          name: workspaces[i],
          path: local_deps_path ? local_deps_path + '/' + workspaces[i] : path.resolve('./' + workspaces[i])
        })
      }
    }
  };

  let remotePackages = [];
  for (var depRange in lockedDependencies) {
    let dep = lockedDependencies[depRange];

    let depRangeParts = depRange.split('@');
    if (depRange.includes("@file")) {
      let local_path = depRange.split(':')[1]
      let name = local_path.split("/").slice(-1)[0]
      localPackages.push({
        name: name,
        path: local_deps_path ? local_deps_path + local_path.substring(1) : path.resolve(local_path)
      })
      if (found.hasOwnProperty(name)) {
        continue;
      } else {
        found[name] = null;
      }
    }
    else {
      let [url, sha1] = dep["resolved"].split("#");
      let file_name = path.basename(url)
      let drv_name = file_name
      if (is_type(url)) {
        // Nix doesn't support special charaters in drv name
        drv_name = file_name
        file_name = "@types-" + file_name
      }

      if (is_cypres(url)) {
        // Nix doesn't support special charaters in drv name
        drv_name = file_name
        file_name = "@cypress-" + file_name
      }
      if (found.hasOwnProperty(file_name)) {
        continue;
      } else {
        found[file_name] = null;
      }
      remotePackages.push({
        drv_name: drv_name,
        file_name: file_name,
        url: url,
        sha1: sha1
      })

    }
  }
  let remotes = remotePackages.map(remoteToString)
  let locals = localPackages.map(localToString)
  console.log(`packages = ${arrayToString(remotes)};`)
  console.log(`localPackages = ${arrayToString(locals)};`)

  console.log(" ")
  console.log("}")
}


function getSha1(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const { statusCode } = res;
      const hash = crypto.createHash('sha1');
      if (statusCode !== 200) {
        const err = new Error('Request Failed.\n' +
          `Status Code: ${statusCode}`);
        // consume response data to free up memory
        res.resume();
        reject(err);
      }

      res.on('data', (chunk) => { hash.update(chunk); });
      res.on('end', () => { resolve(hash.digest('hex')) });
      res.on('error', reject);
    });
  });
};

function updateResolvedSha1(pkg) {
  // local dependency
  if (!pkg.resolved) { return Promise.resolve(); }
  let [url, sha1] = pkg.resolved.split("#", 2)
  if (!sha1) {
    return new Promise((resolve, reject) => {
      getSha1(url).then(sha1 => {
        pkg.resolved = `${url}#${sha1}`;
        resolve();
      }).catch(reject);
    });
  } else {
    // nothing to do
    return Promise.resolve();
  };
}

function values(obj) {
  var entries = [];
  for (let key in obj) {
    entries.push(obj[key]);
  }
  return entries;
}

////////////////////////////////////////////////////////////////////////////////
// Main
////////////////////////////////////////////////////////////////////////////////

var options = docopt(USAGE);

let data = fs.readFileSync(options['--lockfile'], 'utf8')
let package_json_path = options['--path'] + '/package.json'
let package_json = require(package_json_path)
let workspaces = package_json.workspaces

let json = lockfile.parse(data)
if (json.type != "success") {
  throw new Error("yarn.lock parse error")
}
// Check fore missing hashes in the yarn.lock and patch if necessary
var pkgs = values(json.object);
Promise.all(pkgs.map(updateResolvedSha1)).then(() => {
  let newData = lockfile.stringify(json.object);


  if (!options['--no-nix']) {
    let local_deps_path = options["--path"]
    generateNix(json.object, local_deps_path, workspaces);
  }
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
