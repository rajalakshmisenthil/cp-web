'use strict';
/*******************************************************************************
 * Copyright (c) 2015 IBM Corp.
 *
 * All rights reserved.
 *
 * Contributors:
 *   David Huffman - Initial implementation
 *   Dale Avery
 *******************************************************************************/
// =====================================================================================================================
// 												Node.js Setup
// =====================================================================================================================
var express = require('express');
var session = require('express-session');
var compression = require('compression');
var serve_static = require('serve-static');
var path = require('path');
var morgan = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var http = require('http');
var https = require('https');
var setup = require('./setup');
var cors = require('cors');
var fs = require('fs');

// =====================================================================================================================
// 												Express Setup
// =====================================================================================================================
// Create the Express app that will process incoming requests to our web server.
console.log('Configuring Express app');
var app = express();
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');
app.engine('.html', require('pug').__express);
app.use(compression());
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));
app.use(cookieParser());

// Create a static folder to serve up the CSS and JS for the demo.  These images shouldn't change very often, so we
// can set longer cache limits for them.
app.use(serve_static(path.join(__dirname, 'public'), {maxAge: '1d', setHeaders: setCustomCC})); // 1 day cache
function setCustomCC(res, path) {
    // 30 days cache
    if (serve_static.mime.lookup(path) === 'image/jpeg') res.setHeader('Cache-Control', 'public, max-age=2592000');
    else if (serve_static.mime.lookup(path) === 'image/png') res.setHeader('Cache-Control', 'public, max-age=2592000');
    else if (serve_static.mime.lookup(path) === 'image/x-icon') res.setHeader('Cache-Control', 'public, max-age=2592000');
}

// Use a session to track how many requests we receive from a client (See below)
app.use(session({secret: 'Somethignsomething1234!test', resave: true, saveUninitialized: true}));

// Enable CORS preflight across the board so browser will let the app make REST requests
app.options('*', cors());
app.use(cors());

// Attach useful things to the request
app.use(function (req, res, next) {
    console.log('----------------------------------------- incoming request -----------------------------------------');
    // Create a bag for passing information back to the client
    req.bag = {};
    req.session.count = req.session.count + 1;
    req.bag.session = req.session;

    // TODO is anything using this?
    var url_parts = require('url').parse(req.url, true);
    req.parameters = url_parts.query;
    next();
});

// This router will serve up our pages and API calls.
var router = require('./routes/site_router');
app.use('/', router);

// If the request is not process by this point, their are 2 possibilities:
// 1. We don't have a route for handling the request
app.use(function (req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

// 2. Something else went wrong
app.use(function (err, req, res, next) {		// = development error handler, print stack trace
    console.log('Error Handler -', req.url);
    var errorCode = err.status || 500;
    res.status(errorCode);
    req.bag.error = {msg: err.stack, status: errorCode};
    if (req.bag.error.status == 404) req.bag.error.msg = 'Sorry, I cannot locate that file';
    res.render('template/error', {bag: req.bag});
});

// =====================================================================================================================
// 												Launch Webserver
// =====================================================================================================================
// Start the web server using our express app to handle requests
var host = setup.SERVER.HOST;
var port = setup.SERVER.PORT;
console.log('Staring http server on: ' + host + ':' + port);
var server = http.createServer(app).listen(port, function () {
    console.log('Server Up - ' + host + ':' + port);
});

// Some setting that we've found make our life easier
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
server.timeout = 240000;

// Track application bluemix deployments.  All we're tracking is number of deployments.
console.log('---- Tracking Deployment');
require('cf-deployment-tracker-client').track();

// =====================================================================================================================
// 												Blockchain Setup
// =====================================================================================================================
var part2 = require('./utils/ws_part2');
var ws = require('ws');
var wss = {};
var user_manager = require('./utils/users');
var hfc = require('hfc');
var chaincodeName = 'cp_chaincode';
var chain = hfc.newChain(chaincodeName);

// Configure the KeyValStore which is used to store sensitive keys
// as so it is important to secure this storage.
var keyValStoreDir = __dirname + '/keyValStore';
console.log('Creating keyValStore in', keyValStoreDir);
chain.setKeyValStore(hfc.newFileKeyValStore(__dirname + '/keyValStore'));
chain.setDeployWaitTime(100);
chain.setECDSAModeForGRPC(true);

// ==================================
// load peers manually or from VCAP, VCAP will overwrite hardcoded list!
// ==================================

var peerURLs = [];
var caURL = null;
var users = null;
var peerHosts = [];

//hard-coded the peers and CA addresses.
//added for reading configs from file
try {
    console.log('Attempting to read hardcoded network credentials...');
    var manual = JSON.parse(fs.readFileSync('mycreds.json', 'utf8'));

    // Sometimes the credentials from Bluemix are wrapped, sometimes not.
    if (manual.credentials) {
        manual = manual.credentials;
    }

    var peers = manual.peers;
    for (var i in peers) {
        peerURLs.push('grpcs://' + peers[i].discovery_host + ':' + peers[i].discovery_port);
        peerHosts.push('' + peers[i].discovery_host);
    }
    var ca = manual.ca;
    for (var i in ca) {
        caURL = 'grpcs://' + ca[i].url;
    }
    console.log('loading hardcoded peers');
    users = null;																			//users are only found if security is on
    if (manual.users) users = manual.users;
    console.log('loading hardcoded users');
}
catch (e) {
    console.log('Error - could not find hardcoded peers/users, this is okay if running in bluemix');
}

if (process.env.VCAP_SERVICES) {
    //load from vcap, search for service, 1 of the 3 should be found...
    var servicesObject = JSON.parse(process.env.VCAP_SERVICES);
    for (var i in servicesObject) {
        if (i.indexOf('ibm-blockchain') >= 0) {											//looks close enough
            if (servicesObject[i][0].credentials.error) {
                console.log('!\n!\n! Error from Bluemix: \n', servicesObject[i][0].credentials.error, '!\n!\n');
                peers = null;
                users = null;
                process.error = {
                    type: 'network',
                    msg: 'Due to overwhelming demand the IBM Blockchain Network service is at maximum capacity.  Please try recreating this service at a later date.'
                };
            }
            if (servicesObject[i][0].credentials && servicesObject[i][0].credentials.peers) {
                console.log('overwritting peers, loading from a vcap service: ', i);
                peers = servicesObject[i][0].credentials.peers;
                peerURLs = [];
                peerHosts = [];
                for (var j in peers) {
                    peerURLs.push('grpcs://' + peers[j].discovery_host + ':' + peers[j].discovery_port);
                    peerHosts.push('' + peers[j].discovery_host);
                }
                if (servicesObject[i][0].credentials.ca) {
                    console.log('overwritting ca, loading from a vcap service: ', i);
                    ca = servicesObject[i][0].credentials.ca;
                    for (var z in ca) {
                        caURL = 'grpcs://' + ca[z].discovery_host + ':' + ca[z].discovery_port;
                    }
                    if (servicesObject[i][0].credentials.users) {
                        console.log('overwritting users, loading from a vcap service: ', i);
                        users = servicesObject[i][0].credentials.users;
                        //TODO extract registrar from users once user list has been updated to new SDK
                    }
                    else users = null;													//no security	
                }
                else ca = null;
                break;
            }
        }
    }
}

var pwd = '';
for (var z in users) {
    if (users[z].enrollId == 'WebAppAdmin') {
        pwd = users[z].enrollSecret;
    }
}
console.log('calling network config');
configure_network();
// ==================================
// configure ibm-blockchain-js sdk
// ==================================

function configure_network() {
    var pem = fs.readFileSync('us.blockchain.ibm.com.cert');

    if (fs.existsSync('us.blockchain.ibm.com.cert')) {
        console.log('Setting membership service url:', caURL);
        chain.setMemberServicesUrl(caURL, {pem: pem});
    }
    else {
        console.log('Failed to get the certificate....');
    }

    console.log('Peer urls:', peerURLs);
    for (var i in peerURLs) {
        chain.addPeer(peerURLs[i], {pem: pem});
    }

    chain.getMember('WebAppAdmin', function (err, WebAppAdmin) {
        if (err) {
            console.log('Failed to get WebAppAdmin member ' + ' ---> ' + err);
        } else {
            console.log('Successfully got WebAppAdmin member' + ' ---> ' /*+ JSON.stringify(crypto)*/);

            // Enroll the WebAppAdmin member with the certificate authority using
            // the one time password hard coded inside the membersrvc.yaml.
            console.log('Enrolling: WebAppAdmin', pwd);
            WebAppAdmin.enroll(pwd, function (err, crypto) {
                if (err) {
                    console.log('Failed to enroll WebAppAdmin member');
                    //t.end(err);
                } else {
                    console.log('Successfully enrolled WebAppAdmin member' + ' ---> ' /*+ JSON.stringify(crypto)*/);

                    // Confirm that the WebAppAdmin token has been created in the key value store
                    path = chain.getKeyValStore().dir + '/member.' + WebAppAdmin.getName();

                    fs.exists(path, function (exists) {
                        if (exists) {
                            console.log('Successfully stored client token for' + ' ---> ' + WebAppAdmin.getName());
                        } else {
                            console.log('Failed to store client token for ' + WebAppAdmin.getName() + ' ---> ' + err);
                        }
                    });
                }
                chain.setRegistrar(WebAppAdmin);
                deploy(WebAppAdmin);
            });
        }
    });
}

function deploy(WebAppAdmin) {
    console.log('Deploying commercial paper chaincode as: WebAppAdmin');
    process.env.GOPATH = __dirname;   //set the gopath to current dir and place chaincode inside src folder
    var deployRequest = {
        fcn: 'init',
        args: ['a', '100'],
        chaincodePath: 'chain_code/',
        certificatePath: '/certs/peer/cert.pem'  // Bluemix cert path has changed
    };
    var deployTx = WebAppAdmin.deploy(deployRequest);

    deployTx.on('submitted', function (results) {
        console.log('Successfully submitted chaincode deploy transaction' + ' ---> ' + 'function: ' + deployRequest.fcn + ', args: ' + deployRequest.args + ' : ' + results.chaincodeID);
    });

    deployTx.on('complete', function (results) {
        console.log('Successfully completed chaincode deploy transaction' + ' ---> ' + 'function: ' + deployRequest.fcn + ', args: ' + deployRequest.args + ' : ' + results.chaincodeID);
        part2.setup(results.chaincodeID, chain, peers);
        user_manager.setup(results.chaincodeID, chain, cb_deployed);
    });

    deployTx.on('error', function (err) {
        // Invoke transaction submission failed
        console.log('Failed to submit chaincode deploy transaction' + ' ---> ' + 'function: ' + deployRequest.fcn + ', args: ' + deployRequest.args + ' : ' + JSON.stringify(err));
    });
}

// ============================================================================================================================
// 												WebSocket Communication Madness
// ============================================================================================================================
function cb_deployed(error, d) {
    if (error != null) {
        //look at tutorial_part1.md in the trouble shooting section for help
        console.log('! looks like the final configuration failed, holding off on the starting the socket\n', error);
        if (!process.error) process.error = {type: 'deploy', msg: error.message};
    }
    else {
        console.log('------------------------------------------ Websocket Up ------------------------------------------');
        wss = new ws.Server({server: server});												//start the websocket now
        wss.on('connection', function connection(ws) {
            ws.on('message', function incoming(message) {
                console.log('received ws msg:', message);
                var data = JSON.parse(message);
                part2.process_msg(ws, data);

            });
            ws.on('close', function () {
            });
        });

        // This makes it easier to contact our clients
        wss.broadcast = function broadcast(data) {
            wss.clients.forEach(function each(client) {
                try {
                    data.v = '2';
                    client.send(JSON.stringify(data));
                }
                catch (e) {
                    console.log('error broadcast ws', e);
                }
            });
        };

        // Monitor chain's blockheight and pass it along to clients.
        setInterval(function () {
            var options = {
                host: peers[0].api_host,
                port: peers[0].api_port,
                path: '/chain',
                method: 'GET'
            };

            function success(statusCode, headers, resp) {
                resp = JSON.parse(resp);
                if (resp && resp.height) {
                    wss.broadcast({msg: 'reset'});
                }
            }

            function failure(statusCode, headers, msg) {
                // Don't broadcast failures to clients, just log them
                console.error('chainstats failure: (' +
                    'status code: ' + statusCode +
                    '\n  headers: ' + headers +
                    '\n  message: ' + msg + ')');
            }

            var request = https.request(options, function (resp) {
                var str = '', chunks = 0;
                resp.setEncoding('utf8');
                resp.on('data', function (chunk) {                                                            //merge chunks of request
                    str += chunk;
                    chunks++;
                });
                resp.on('end', function () {
                    if (resp.statusCode == 204 || resp.statusCode >= 200 && resp.statusCode <= 399) {
                        success(resp.statusCode, resp.headers, str);
                    }
                    else {
                        failure(resp.statusCode, resp.headers, str);
                    }
                });
            });

            request.on('error', function (e) {
                failure(500, null, e);
            });

            request.setTimeout(20000);
            request.on('timeout', function () {                                                                //handle time out event
                failure(408, null, 'Request timed out');
            });

            request.end();
        }, 5000);
    }
}
