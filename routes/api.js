/*
 * Serve JSON to our AngularJS client
 */
var crypto = require('crypto');
var util = require('util');
var async = require('async');
var cfg = require('../cfg/cfg');
var STATS_SECRET = process.env.STATS_SECRET || require('../cfg/secrets').stats_secret;
var Stats = require('../models/stats');
var Match = require('../models/match');
var Counter = require('../models/counter');
var Session = require('../models/session');
var Player = require('../models/player');
var statsEmitter = require('../emitters').statsEmitter;


module.exports = function(app) {
  // JSON API
  app.get('/api/stats/:id', stats);
  app.get('/api/matches', matches);

  app.post('/api/stats/new', createStats);
  app.post('/api/stats/update', updateStats);
  app.post('/api/stats/gameover', gameOver);
};


// GET

var stats = function(req, res) {
  var id = req.params.id;
  Stats.findById(id, function(err, stats) {
    if (err) {
      console.log(err);
      console.trace(err);
      return res.json(false);
    }
    if (!stats) {
      return res.json(false);
    }

    stats.getPlayerData(function(err, playerdata) {
      if (err) {
        console.log(err);
        console.trace(err);
        return res.json(false);
      }
      res.json({ stats: stats, playerdata: playerdata });
    });
    

  });
};

var matches = function(req, res) {
  Match.find({}).sort({_id:-1}).limit(12).exec(function(err, matches) {
    if (err) {
      console.log(err);
      console.trace(err);
      return res.json(false);
    }
    if (!matches) {
      return res.json(false);
    }
    res.json({ matches: matches });
  });
};

// POST

var createStats = function(req, res) {
  // For debugging
  console.log('createStats headers:', req.headers);
  console.log('createStats body:', util.inspect(req.body, false, null, false));

  // 1. Check header for api version
  if (!req.body.stats || req.headers.sizzlingstats !== 'v0.1') { return res.end('false\n'); }

  // 2. Check if POST body contains the necessary info
  if (Object.keys(req.body).length === 0) { return res.end('false\n'); }
  if (!req.body.stats || !req.body.stats.players || req.body.stats.players.length === 0) { return res.end('false\n'); }

  // 3. Massage the POST body data
  // Remove spectators from players array
  for (var i=req.body.stats.players.length-1; i>=0; i--) {
    if (req.body.stats.players[i].team < 2) {
      req.body.stats.players.splice(i,1);
    }
  }
  
  // 4. Generate sessionid.
  var sessionId, matchId, match;
  var ip = req.connection.remoteAddress;

  // We probably need some more/better information in the hmac
  var date = Date.now();
  var hmac = crypto.createHmac('sha1',STATS_SECRET);
  hmac.update(ip + date);
  sessionId = hmac.digest('hex');

  // 5. Then save stats to database.
  async.waterfall([
    // Get matchId (matchCounter.next)
    function(callback) {
      Counter.findOneAndUpdate({ "counter" : "matches" }, { $inc: {next:1} }, callback);
    },
    // Create new session document
    function(matchCounter, callback) {
      if (!matchCounter) { callback(new Error('createStats() -- No matchCounter')); }
      matchId = matchCounter.next;
      new Session({
        _id: sessionId,
        matchId: matchId,
        ip: ip,
        timeout: date + cfg.stats_session_timeout
      }).save(callback);
    },
    // Create new match document
    function(session, affectedDocs, callback) {
      var matchData = {
        _id: matchId,
        hostname: req.body.stats.hostname,
        bluname: req.body.stats.bluname,
        redname: req.body.stats.redname,
        isLive: true
      };
      match = new Match(matchData);
      match.save(callback);
    },
    // Create new stats document
    function(match, affectedDocs, callback) {
      var statsData = req.body.stats;
      statsData.round = 0;
      statsData.redscore = 0;
      statsData.bluscore = 0;
      statsData.roundduration = 0;
      statsData._id = matchId;
      statsData.isLive = true;
      statsData.created = new Date();
      statsData.updated = statsData.created;
      new Stats(statsData).save(callback);
    }
  // async.waterfall callback
  ], function(err, stats) {
    if (err || !stats) {
      console.log(err);
      console.trace(err);
      return res.end('false\n');
    }
    // Emit the 'newMatch' event.
    statsEmitter.emit('newMatch', match);
    // Respond to the gameserver
    res.setHeader('matchurl', cfg.hostname + '/stats?id=' + matchId + '&ingame');
    res.setHeader('sessionid', sessionId);
    res.end('true\n');
    // See if you can update the match with the countrycode info etc.
    match.updateWithPlayerData(stats, function(err) {
      if (err) {
        console.log(err);
        console.trace(err);
        // TODO: do something
      }
    });
  });
};

var updateStats = function(req, res) {
  // For debugging
  console.log('updateStats headers:', req.headers);
  console.log('updateStats body:', util.inspect(req.body, false, null, false));

  if (!req.body.stats || req.headers.sizzlingstats !== 'v0.1') {
    return res.end('false\n');
  }

  var sessionId = req.headers.sessionid;
  if (!sessionId) {
    return res.end('false\n');
  }

  var isEndOfRound = (req.headers.endofround === 'true');
  var ip = req.connection.remoteAddress;
  var matchId;

  // Validate sessionid and update the timeout
  Session.findByIdAndUpdate(sessionId, {$set:{timeout: Date.now()+cfg.stats_session_timeout}}, function(err, session) {
    if (err) {
      console.log(err);
      console.trace(err);
      return res.end('false\n');
    }
    if (!session || ip !== session.ip) return res.end('false\n');

    // The request is validated, now we have to append the new data to the old
    matchId = session.matchId;
    Stats.appendStats(req.body.stats, matchId, isEndOfRound, function(err) {
      if (err) {
        console.log(err);
        console.trace(err);
        return res.end('false\n');
      }
      res.end('true\n');
    });
    
  }); // end Session.findById()
};

var gameOver = function(req, res) {
  // For debugging
  console.log('gameOver headers:', req.headers);
  console.log('gameOver body:', util.inspect(req.body, false, null, true));

  if (!req.headers.matchduration || req.headers.sizzlingstats !== 'v0.1') {
    return res.end('false\n');
  }

  var newChats = [];
  if (req.body.chats) { newChats = req.body.chats; }
  
  var sessionId = req.headers.sessionid;
  var matchDuration = parseInt(req.headers.matchduration, 10);
  var ip = req.connection.remoteAddress;

  // Validate sessionid
  Session.findById(sessionId, function(err, session) {
    if (err) {
      console.log(err);
      console.trace(err);
      return res.end('false\n');
    }
    if (!session || ip !== session.ip) return res.end('false\n');

    // The request is validated, now set game over
    var matchId = session.matchId;

    Stats.setGameOver(matchId, matchDuration, newChats, function(err) {
      if (err) {
        console.log(err);
        console.trace(err);
        return res.end('false\n');
      }

      Match.setGameOver(session.matchId, null, function(err) {
        if (err) { console.log(err); console.trace(err); }
      });

      // If all went well, expire the sessionkey and send HTTP response
      session.expireSessionKey(function(err) {
        if (err) {
          console.log(err);
          console.trace(err);
          return res.end('false\n');
        }
        res.end('true\n');
      });
    });
    
  }); // end Session.findById()
};
