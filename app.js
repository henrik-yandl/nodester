/* 

Nodester opensource Node.js hosting service

Written by: @ChrisMatthieu & @DanBUK
http://nodester.com

*/

var express = require('express');
var url = require('url');
var crypto = require('crypto');
var sys = require('sys');
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var fs = require('fs');
var npmwrapper = require('npm-wrapper').npmwrapper;
var request = require('request');
var lib = require("./lib");
var cradle = require('cradle');

var h = {accept: 'application/json', 'content-type': 'application/json'};

var config = require("./config");
var couch_loc = "http://" + config.opt.couch_user + ":" + config.opt.couch_pass + "@" + config.opt.couch_host + ":" + config.opt.couch_port + "/";
if (config.opt.couch_prefix.length > 0) {
  couch_loc += config.opt.couch_prefix + "_";
}

var myapp = express.createServer();

myapp.configure(function(){
  myapp.use(express.bodyDecoder());
  myapp.use(express.staticProvider(__dirname + '/public'));
});

// Routes
// Homepage
myapp.get('/', function(req, res, next){
  res.render('index.html');
});

// Status API
// http://localhost:8080/status 
// curl http://localhost:8080/status
myapp.get('/status', function(req, res, next) {
  request({ method: 'GET', uri: couch_loc + 'apps/_design/nodeapps/_view/all', headers: h}, function (err, response, body) {
    var docs = JSON.parse(body);
    var hostedapps = 0;
    var countrunning = 0;
    if (docs) { // Maybe better error handling here
      var i;
      for (i=0; i<docs.rows.length; i++) {
        if (docs.rows[i].value.running == "true"){
          countrunning++;
        }
      }
      hostedapps = docs.rows.length.toString();
    }
    countrunning = countrunning.toString();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"status" : "up", "appshosted" : "' + hostedapps + '", "appsrunning" : "' + countrunning + '"}\n');
    res.end();
  });
});

// New coupon request
// curl -X POST -d "email=dan@nodester.com" http://localhost:8080/coupon
myapp.post('/coupon', function(req, res, next) {

  var email = req.param("email");  
  if (typeof email != 'undefined') {
    request({uri:couch_loc + "coupons", method:'POST', body: JSON.stringify({_id: email}), headers:h}, function (err, response, body) {
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(JSON.stringify({status: "success - you are now in queue to receive an invite on our next batch!"}) + "\n");
    res.end();
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(JSON.stringify({status: "failure - please try again shortly!"}) + "\n");
    res.end();
  }

});


// New user account registration
// curl -X POST -d "user=testuser&password=123&email=chris@nodefu.com&coupon=hiyah" http://localhost:8080/user
// curl -X POST -d "user=me&password=123&coupon=hiyah" http://localhost:8080/user
myapp.post('/user', function(req, res, next){

  var newuser = req.param("user");
  var newpass = req.param("password");
  var email = req.param("email");
  var coupon = req.param("coupon");
  var rsakey = req.param("rsakey");  
  
  if(coupon == config.opt.coupon_code) {

    request({uri:couch_loc + 'nodefu/' + newuser, method:'GET', headers:h}, function (err, response, body) {
      var doc = JSON.parse(body);
      if (doc._id){
        // account already registered
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.write('{"status": "failure - account exists"}\n');
        res.end();
      } else {
        if (typeof rsakey == 'undefined') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.write('{"status": "failure - rsakey is invalid"}\n');
          res.end();
        } else {
          stream = fs.createWriteStream(config.opt.home_dir + '/.ssh/authorized_keys', {
            'flags': 'a+',
            'encoding': 'utf8',
            'mode': 0644
          });

          stream.write('command="/usr/local/bin/git-shell-enforce-directory ' + config.opt.home_dir + '/' + config.opt.hosted_apps_subdir + '/' + newuser + '",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ' + rsakey + '\n', 'utf8');
          stream.end();
        
          // Save user information to database and respond to API request
          request({uri: couch_loc + 'nodefu', method:'POST', body: JSON.stringify({_id: newuser, password: md5(newpass), email: email}), headers: h}, function (err, response, body) {
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write('{"status": "success"}\n');
          res.end();
        }
      }
    });

  } else {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.write('{"status": "failure - invalid coupon"}\n');
    res.end();
  };

});

// api.localhost requires basic auth to access this section
// Edit your user account 
// curl -X PUT -u "testuser:123" -d "password=test&rsakey=1234567" http://api.localhost:8080/user
myapp.put('/user', function(req, res, next) {
  var user
  var newpass = req.param("password");
  var rsakey = req.param("rsakey");

  authenticate(req.headers.authorization, res, function(user) {
    if (newpass) {
      request({uri:couch_loc + 'nodefu/' + user._id, method:'PUT', body: JSON.stringify({_rev: user._rev, password: md5(newpass) }), headers:h}, function (err, response, body) {});
    };
    if (rsakey) {
      stream = fs.createWriteStream(config.opt.home_dir + '/.ssh/authorized_keys', {
        'flags': 'a+',
        'encoding': 'utf8',
        'mode': 0644
      });
      stream.write('command="/usr/local/bin/git-shell-enforce-directory ' + config.opt.home_dir + '/' + config.opt.hosted_apps_subdir + '/' + user._id + '",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ' + rsakey + '\n', 'utf8');
      stream.end();
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"status" : "success"}\n');
    res.end();
  });
});

// Delete your user account 
// curl -X DELETE -u "testuser:123" http://api.localhost:8080/user
myapp.delete('/user', function(req, res, next) {
  var user
  authenticate(req.headers.authorization, res, function(user) {
    // need to delete all users apps
    // and stop all the users apps

    request({uri:couch_loc + 'nodefu/' + user._id + '?rev=' +  user._rev, method:'DELETE', headers:h}, function (err, response, body) {
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"status" : "success"}\n');
    res.end();
  });
});

// Create node app 
// curl -X POST -u "testuser:123" -d "appname=test&start=hello.js" http://api.localhost:8080/apps
myapp.post('/app', function(req, res, next) {
  var user
  authenticate(req.headers.authorization, res, function(user) {
    if(user) {
      var appname = req.param("appname").toLowerCase();
      var start = req.param("start");
      request({uri:couch_loc + 'apps/' + appname, method:'GET', headers:h}, function (err, response, body) {
        var myObject = JSON.parse(body);
        if (myObject._id){
          // subdomain already exists
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.write('{"status" : "failure - appname exists"}\n');
          res.end();
        } else {
          // subdomain available - get next available port address
          request({uri:couch_loc + 'nextport/port', method:'GET', headers:h}, function (err, response, body) {
            var doc = JSON.parse(body);
            if (typeof doc.error != 'undefined' && doc.error == 'not_found') {
              var appport = 8000;
            } else {
              var appport = doc.address
            }
            var repo_id = doc._rev;
            // increment next port address
            request({uri:couch_loc + 'nextport/port', method:'PUT', body: JSON.stringify({_id: "port", address: appport + 1, _rev: doc._rev}), headers:h}, function (err, response, body) {
              var doc = JSON.parse(body);
              // Create the app
              request({uri:couch_loc + 'apps', method:'POST', body: JSON.stringify({_id: appname, start: start, port: appport, username: user._id, repo_id: repo_id, running: false, pid: 'unknown' }), headers:h}, function (err, response, body) {
                var doc = JSON.parse(body);
                request({uri:couch_loc + 'repos', method:'POST', body: JSON.stringify({_id: repo_id, appname: appname, username: user._id}), headers:h}, function (err, response, body) {
                  // TODO - Error handling...
                });
                // Setup git repo
                var gitsetup = spawn(config.opt.app_dir + '/scripts/gitreposetup.sh', [config.opt.app_dir, config.opt.home_dir + '/' + config.opt.hosted_apps_subdir, user._id, repo_id, start]);
                // Respond to API request
                res.writeHead(200, { 'Content-Type': 'application/json' });
                // res.write('{"status" : "success", "port" : "' + appport + '", "gitrepo" : "' + config.opt.git_user + '@' + config.opt.git_dom + ':' + config.opt.home_dir + '/' + config.opt.hosted_apps_subdir + '/' + user._id  + '/' + repo_id + '.git", "start": "' + start + '", "running": false, "pid": "unknown"}\n');
                res.write(JSON.stringify({status: "success", port: appport, gitrepo: config.opt.git_user + '@' + config.opt.git_dom + ':' + config.opt.home_dir + '/' + config.opt.hosted_apps_subdir + '/' + user._id + '/' + repo_id + '.git', start: start, running: false, pid: "unknown"}) + "\n");
                res.end();
              });
            });
          });
        };
      });
    };
  });
});

// Update node app
// start=hello.js - To update the initial run script
// running=true - To Start the app
// running=false - To Stop the app
// curl -X PUT -u "testuser:123" -d "appname=test&start=hello.js" http://api.localhost:8080/app
// curl -X PUT -u "testuser:123" -d "appname=test&running=true" http://api.localhost:8080/app
// curl -X PUT -u "testuser:123" -d "appname=test&running=false" http://api.localhost:8080/app
// curl -X PUT -u "testuser:123" -d "appname=test&running=restart" http://api.localhost:8080/app
// TODO - Fix this function, it's not doing callbacking properly so will return JSON in the wrong state!
myapp.put('/app', function(req, res, next){
  var appname = req.param("appname").toLowerCase();
  authenticate_app(req.headers.authorization, appname, res, function (user, app) {
    var crud = new cradle.Connection({
      host: config.opt.couch_host,
      port: config.opt.couch_port,
      auth: {user: config.opt.couch_user, pass: config.opt.couch_pass},
      options: {cache: true, raw: false}
    });
    var db = crud.database(lib.couch_prefix + 'apps');
    db.get(appname, function (err, appdoc) {
      console.log("err: " + err);
      console.log("doc: " + appdoc);
      var start = req.param("start");
      var app_user_home = config.opt.home_dir + '/' + config.opt.hosted_apps_subdir + '/' + appdoc.username;
      var app_home = app_user_home + '/' + appdoc.repo_id;
      var app_repo = config.opt.git_user + '@' + config.opt.git_dom + ':' + config.opt.home_dir + '/' + config.opt.hosted_apps_subdir + '/' + appdoc.username + '/' + appdoc.repo_id + '.git';
      if (typeof start != 'undefined' && start.length > 0) {
        db.merge(appname, {start: start}, function (err, resp) {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.write(JSON.stringify({status: success, port: appdoc.port, gitrepo: app_repo, start: start, running: appdoc.running, pid: appdoc.pid}) + "\n");
          res.end();
        });
      } else {
        var running = req.param("running");
        switch (running) {
          case "true":
            if (appdoc.running == "true") {
              res_error(res, 408, "failure - application already running.");
            } else {
              app_start(appdoc.repo_id, function (rv) {
                if (rv == true) {
                  var success = "success";
                  var running = "true";
                } else {
                  var success = "false";
                  var running = "failed-to-start";
                }
                db.merge(appname, {running: running}, function (err, resp) {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.write(JSON.stringify({status: success, port: appdoc.port, gitrepo: app_repo, start: appdoc.start, running: running, pid: appdoc.pid}) + "\n");
                  res.end();
                });
              });
            }
            break;
          case "restart":
            app_restart(app.repo_id, function (rv) {
              if (rv == true) {
                var success = "success";
                var running = "true";
              } else {
                var success = "false";
                var running = "failed-to-restart";
              }
              db.merge(appname, {running: running}, function (err, resp) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.write(JSON.stringify({status: success, port: appdoc.port, gitrepo: app_repo, start: appdoc.start, running: running, pid: appdoc.pid}) + "\n");
                res.end();
              });
            });
            break;
          case "false":
            if (app.running == 'false') {
              res_error(res, 408, "failure - application already stopped.");
            } else {
              app_stop(app.repo_id, function (rv) {
                if (rv == true) {
                  var success = "success";
                  var running = "false";
                } else {
                  var success = "false";
                  var running = "failed-to-stop";
                }
                db.merge(appname, {running: running}, function (err, resp) {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.write(JSON.stringify({status: success, port: appdoc.port, gitrepo: app_repo, start: appdoc.start, running: running, pid: appdoc.pid}) + "\n");
                  res.end();
                });
              });
            }
            break;
          default:
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.write(JSON.stringify({status: "false", message: "Invalid action."}) + "\n");
            res.end();
            break;
        }
      }
    });
  });
});

var app_stop = function (repo_id, callback) {
  request({uri:couch_loc + 'repos/' + repo_id, method:'GET', headers:h}, function (err, response, body) {
    var doc = JSON.parse(body);
    if (typeof doc.error != 'undefined' && doc.error == 'not_found') {
      callback(false);
    } else {
      var app_home = config.opt.home_dir + '/' + config.opt.hosted_apps_subdir + '/' + doc.username + '/' + doc._id;
      fs.readFile(app_home + '/.app.pid', function (err, data) {
        if (err) {
          callback(false);
        } else {
          try {
            var p = parseInt(data.toString());
            if (p > 0) {
              process.kill(parseInt(data));
              fs.unlink(app_home + '/.app.pid');
            } else {
              console.log(sys.inspect(data.toString()));
            }
            callback(true);
          } catch (e) {
            callback(false);
          }
        }
      });
    }
  });
};

var app_start = function (repo_id, callback) {
  request({uri:couch_loc + 'repos/' + repo_id, method:'GET', headers:h}, function (err, response, body) {
    var doc = JSON.parse(body);
    if (typeof doc.error != 'undefined' && doc.error == 'not_found') {
      callback(false);
    } else {
      var user_home = config.opt.home_dir + '/' + config.opt.hosted_apps_subdir + '/' + doc.username;
      var app_home = user_home + '/' + repo_id;
      request({ method: 'GET', uri: couch_loc + 'apps/' + doc.appname, headers: h}, function (err, response, body) {
        var app = JSON.parse(body);
        if (typeof app.error != 'undefined' && app.error == 'not_found') {
          callback(false);
        } else {
          var cmd = "sudo " + config.opt.app_dir + '/scripts/launch_app.sh ' + config.opt.app_dir + ' ' + config.opt.userid + ' ' + app_home + ' ' + app.start + ' ' + app.port + ' ' + '127.0.0.1' + ' ' + doc.appname; 
          sys.puts(cmd);
          var child = exec(cmd, function (error, stdout, stderr) {});
          callback(true);
        }
      });
    }
  });
};

var app_restart = function (repo_id, callback) {
  app_stop(repo_id, function (rv) {
    setTimeout(function () {
      app_start(repo_id, function (rv) {
        if (rv == false) {
          callback(false);
        } else {
          callback(true);
        }
      });
    }, 1000);
  });
};

// App backend restart handler
// 
myapp.get('/app_restart', function(req, res, next) {
  var repo_id = req.param("repo_id");
  var restart_key = req.param("restart_key");
  if (restart_key != config.opt.restart_key) {
    res.writeHead(403, {'Content-Type': 'text/plain'});
    res.end();
  } else {
    app_restart(repo_id, function(rv) {
      if (rv == false) {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end('{"status": "failed to restart"}\n');
      } else {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end('{"status": "restarted"}\n');
      }
    }, true);
  }
});


// Delete your nodejs app 
// curl -X DELETE -u "testuser:123" -d "appname=test" http://api.localhost:8080/apps
myapp.delete('/app', function(req, res, next){
  var appname = req.param("appname").toLowerCase();
  authenticate_app(req.headers.authorization, appname, res, function (user, app) {
    request({uri: couch_loc + 'apps/' + appname + '?rev=' + app._rev, method:'DELETE', headers: h}, function (err, response, body) {
      // Error checking oO
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"status" : "success"}\n');
    res.end();
  });
});

// Application info
// http://chris:123@api.localhost:8080/app/<appname>
// curl -u "testuser:123" http://api.localhost:8080/app/<appname>
myapp.get('/app/:appname', function(req, res, next){
  var appname = req.param("appname").toLowerCase();
  authenticate_app(req.headers.authorization, appname, res, function (user, app) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // res.write('{"status" : "success", port : "' + app.port + '", gitrepo : "' + config.opt.git_user + '@' + config.opt.git_dom + ':' + config.opt.home_dir + '/' + config.opt.hosted_apps_subdir + '/' + app.username + '/' + app.repo_id + '.git", start: "' + app.start + '", running: ' + app.running + ', pid: ' + app.pid + '}\n');
    res.write(JSON.stringify({status: "success", port: app.port, gitrepo: config.opt.git_user + '@' + config.opt.git_dom + ':' + config.opt.home_dir + '/' + config.opt.hosted_apps_subdir + '/' + app.username + '/' + app.repo_id + '.git', start: app.start, running: app.running, pid: app.pid}) + "\n");
    res.end();
  });
}); 

// All Applications info
// http://chris:123@api.localhost:8080/apps
// curl -u "testuser:123" http://api.localhost:8080/apps
myapp.get('/apps', function(req, res, next){
  authenticate(req.headers.authorization, res, function (user) {
    request({ method: 'GET', uri: couch_loc + 'apps/' + '/_design/nodeapps/_view/all', headers: h}, function (err, response, body) {  
      var docs = JSON.parse(body);
      if (docs) { // Maybe better error handling here
        var apps = [];
        var i;
        for (i=0; i<docs.rows.length; i++) {
          if (user._id == docs.rows[i].value.username) {
            apps.push({
              name: docs.rows[i].id
            , port: docs.rows[i].value.port
            , gitrepo: config.opt.git_user + '@' + config.opt.git_dom + ':' + config.opt.home_dir + '/' + config.opt.hosted_apps_subdir + '/' + docs.rows[i].value.username + '/' + docs.rows[i].value.repo_id + '.git'
            , start: docs.rows[i].value.start
            , running: docs.rows[i].value.running
            , pid: docs.rows[i].value.pid
            });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write(JSON.stringify(apps));
        res.end();
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.write('{"status" : "failure - applications not found"}');
        res.end();
      }
    });
  });
});


// APP NPM Handlers
// http://user:pass@api.localhost:8080/npm

myapp.post('/test', function(req, res, next) {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('test\n');
});

myapp.post('/appnpm', function(req, res, next) {
  var appname = req.param("appname").toLowerCase();
  var action = req.param("action");
  var package = req.param("package");
  authenticate_app(req.headers.authorization, appname, res, function (user, app) {
    var good_action = true;
    switch (action) {
      case "install":
        break;
      case "update":
        break;
      case "uninstall":
        break;
      default:
        good_action = false;
        break;
    }

    (function(){
    if(good_action === true) {
      var app_user_home = config.opt.home_dir + '/' + config.opt.hosted_apps_subdir + '/' + user._id + '/' + app.repo_id;
      sys.puts(action + " " + package + " into " + app_user_home);
      var cmd = 'npm ' + action + ' ' + package + ' --root ' + app_user_home + '/.node_libraries --binroot ' + app_user_home + '/.npm_bin --manpath ' + app_user_home + '/.npm_man';
      var pr = exec(cmd, function (err, stdout, stderr) {
        var rtv = "stdout: " + stdout + "\nstderr: " + stderr;
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.write(JSON.stringify({"status": 'success', output: rtv}) + '\n');
        res.end();
      });
/*
      Why oh why doesn't this work.. Still the code above is, so that's good for me!
      var app_user_home = config.opt.home_dir + '/' + config.opt.hosted_apps_subdir + '/' + user._id + '/' + app.repo_id;
      var n = new npmwrapper();
      n.setup(app_user_home + '/.node_libraries', app_user_home + '/.npm_bin', app_user_home + '/.npm_man', action, package);
      n.run(function (output) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.write(JSON.stringify({"status": 'success', output: output}) + '\n');
        res.end();
      });
*/
    } else {
      res.writeHead(400, {'Content-Type': 'application/json'});
      res.write('{"status": "failure - invalid action parameter"}\n');
      res.end();
    }
    })();
  });
});

myapp.post('/appdomains', function(req, res, next) {
  var appname = req.param("appname").toLowerCase();
  var action = req.param("action");
  var domain = req.param("domain");
  authenticate_app(req.headers.authorization, appname, res, function (user, app) {
    switch (action) {
      case "add":
        var gooddomain = lib.checkDomain(domain);
        if (gooddomain === true) {
          request({uri:couch_loc + 'aliasdomains/' + domain, method:'GET', headers:h}, function (err, response, body) {
            var doc = JSON.parse(body);
            if (doc._id){
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.write('{"status": "failure - domain already exists"}\n');
              res.end();
            } else {
              request({uri:couch_loc + 'aliasdomains', method:'POST', body: JSON.stringify({_id: domain, appname: appname}), headers: h}, function (err, response, body) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.write('{"status": "success", "message": "Domain added."}\n');
                res.end();
              });
            }
          });
        } else {
          res.writeHead(400, {'Content-Type': 'application/json'});
          res.write('{"status": "failure - ' + gooddomain + '"}\n');
          res.end();
        }
        break;
      case "delete":
        var gooddomain = lib.checkDomain(domain);
        if (gooddomain === true) {
          request({uri:couch_loc + 'aliasdomains/' + domain, method:'GET', headers:h}, function (err, response, body) {
            var doc = JSON.parse(body);
            if (doc._id) {
              if (doc.appname == appname) {
                request({uri:couch_loc + 'aliasdomains/' + domain + '?rev=' + doc._rev, method:'DELETE', headers:h}, function (err, response, body) {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.write('{"status": "success", "message": "Domain deleted."}\n');
                  res.end();
                });
              } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.write('{"status": "failure - domain is not for this app."}\n');
                res.end();
              }
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.write('{"status": "failure - domain not found."}\n');
                res.end();
            }
          });
        } else {
          res.writeHead(400, {'Content-Type': 'application/json'});
          res.write('{"status": "failure - ' + gooddomain + '"}\n');
          res.end();
        }
        break;
      default:
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.write('{"status": "failure - invalid action parameter"}\n');
        res.end();
        break;
    }
  });
});


myapp.get('/applogs/:appname', function(req, res, next) {
  var appname = req.param("appname").toLowerCase();
//  var num = parseInt(req.param("num"));
  authenticate_app(req.headers.authorization, appname, res, function (user, app) {
    var app_user_home = config.opt.home_dir + '/' + config.opt.hosted_apps_subdir + '/' + user._id + '/' + app.repo_id;
    fs.readFile(app_user_home + '/error.log', function (err, body) {
      if (err) {
        var code = 500;
        var resp = {error: "Failed to read error log."};
      } else {
        var code = 200;
        var lines = body.toString().split("\n");
        lines = lines.slice(-100);
        var resp = {success: true, lines: lines};
      }
      res.writeHead(code, {'Content-Type': 'application/json'});
      res.write(JSON.stringify(resp) + '\n');
      res.end();
    });
  });
});


myapp.get('/unsent', function (req, res, next) {
//  authenticate(req.headers.authorization, res, function(user) {
//    if (user._id == 'dan') {
      request({uri:couch_loc + 'coupons/_design/coupons/_view/unsent', method:'GET', headers:h}, function (err, response, body) {
        var doc = JSON.parse(body);
        var buff = "";
        for(var i in doc.rows) {
          // sys.puts(doc.rows[i].id);
          buff += doc.rows[i].id + '\n';
        }
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end(buff);
      });
//    } else {
//      res.writeHead(401, { 'Content-Type': 'application/json' });
//      res.end('{"status" : "failure - authentication"}\n');
//    }
//  });
});

var authenticate_app = function (auth_infos, appname, res, callback) {
  authenticate(auth_infos, res, function(user) {
    if (typeof user != 'undefined') {
      request({ method: 'GET', uri: couch_loc + 'apps/' + appname, headers: h}, function (err, response, body) {
        var doc = JSON.parse(body);
        if (doc && doc.username == user._id) {
          callback(user, doc);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"status" : "failure - app not found"}\n');
        }
      });
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"status" : "failure - authentication"}\n');
    }
  });
};

myapp.use(express.errorHandler({ showStack: true }));
myapp.listen(4001); 
console.log('Nodester app started on port 4001');

function authenticate(basicauth, res, callback) {
  if (typeof basicauth != 'undefined' && basicauth.length > 0) {
    var buff = new Buffer(basicauth.substring(basicauth.indexOf(" ") + 1 ), encoding='base64');
    var creds = buff.toString('ascii')

    var username = creds.substring(0,creds.indexOf(":"));
    var password = creds.substring(creds.indexOf(":")+1);

    request({uri:couch_loc + 'nodefu/' + username, method:'GET', headers:h}, function (err, response, body) {
      var doc = JSON.parse(body);

      if(doc && doc._id == username && doc.password == md5(password)){
        callback(doc);
      } else {
        // basic auth didn't match account
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.write('{"status" : "failure - authentication"}\n');
        res.end();
      }
    });
  } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.write('{"status" : "failure - authentication"}\n');
      res.end();
  }
};

var res_error = function (res, code, message) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.write('{"status" : "' + message + '"}\n');
  res.end();
};

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

process.on('uncaughtException', function (err) {
   console.log("uncaughtException" + sys.inspect(err));
});
