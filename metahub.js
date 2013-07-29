// cached wrapper around Github
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var qequire = require('qequire');
var GitHubApi = require('github');

var _ = require('lodash');
var Q = require('q');
Q.longStackSupport = true;


var makeCache = require('./lib/cache');
var makeServer = require('./lib/server');

// recursively remove *_url props
var stripUrl = require('./lib/strip-url');

var Metahub = function (config) {
  this.config = config;

  this.config.msg = {
    user: config.target.user,
    repo: config.target.repo
  };

  this.rest = qequire.quire(
    config.gitHubApi ||
      new GitHubApi({
        version: '3.0.0'
      }));

  this.rest.authenticate({
    type: 'basic',
    username: config.login.username,
    password: config.login.password
  });

  this.cache = makeCache();
  this.server = config.server || makeServer();
  this.server.on('hook', this._merge.bind(this));

  this.repo = null;
  this.issues = null;
  this.prs = null;
};

util.inherits(Metahub, EventEmitter);

// grab all data from Github API and cache it
Metahub.prototype._populate = function () {
  this.log('Populating cache');
  return this._populateRepo().
    then(function (repo) {
      if (this.cache.exists('repo')) {
        this.repo = this.cache.get('repo');
        if (Date.parse(repo.updated_at) > Date.parse(this.repo.updated_at)) {
          this.log('Cache is stale');
          this.repo = repo;
          this.cache.set('repo', repo);
        } else {
          this.issues = this.cache.get('issues');
          return;
        }
      } else {
        this.log('No repo cache');
        this.cache.set('repo', repo);
        this.repo = repo;
      }
      return this._populateAndCacheIssues(repo).
        then(function () {
          this.log('Done caching repo issues');
        }.bind(this));
    }.bind(this));
};

Metahub.prototype._populateIssues = require('./lib/scrape-issues');

Metahub.prototype._populateAndCacheIssues = function (repo) {
  this.log('Scraping issue data from Github API');
  return this._populateIssues(repo).
    then(function (issues) {
      this.issues = issues;
      this._cacheIssues();
    }.bind(this));
};

Metahub.prototype._populateRepo = function () {
  return this.rest.repos.get(this.config.msg).
    then(stripUrl);
};

Metahub.prototype.start = function () {
  return this._populate().
    then(function () {
      this.server.listen(this.config.hook.port);
    }.bind(this));
}

Metahub.prototype.clearCache = function () {
  if (this.cache.exists('repo')) {
    this.cache.clear('repo');
  }
};

Metahub.prototype.getHooks = function () {
  return this.rest.repos.getHooks(this.config.msg).
    then(stripUrl);
};

Metahub.prototype.getCommits = function (number) {
  var msg = _.defaults({
    number: number
  }, this.config.msg);
  return this.rest.pullRequests.getCommits(msg).
    then(stripUrl);
};

Metahub.prototype.createComment = function (number, body) {
  var msg = _.defaults({
    number: number,
    body: body
  }, this.config.msg);

  return this.rest.issues.createComment(msg).
    then(stripUrl);
};

Metahub.prototype.createHook = function () {

  var msg = _.defaults({
    name: 'web',
    active: true,
    events: [
      'pull_request',
      'issues',
      'issue_comment'
    ],
    config: {
      url: this.config.hook.url,
    }
  }, this.config.msg);

  return this.rest.repos.createHook(msg);
};

Metahub.prototype.updateHook = function (id, args) {
  if (!id) {
    if (!this.cache.exists('hook')) {
      throw new Error('No id given');
    }
    id = this.cache.get('hook');
  }

  var msg = _.defaults(args || {}, this.config.msg, {
    id: id,
    name: 'web',
    events: [
      'pull_request',
      'issues',
      'issue_comment'
    ],
    config: {
      url: this.config.hook.url,
    }
  });

  return this.rest.repos.updateHook(msg);
};

Metahub.prototype.enableHook = function (id) {
  return this.updateHook(id, {
    active: true
  });
};

Metahub.prototype.disableHook = function (id) {
  return this.updateHook(id, {
    active: false
  });
};

Metahub.prototype.deleteHook = function (id) {
  if (!id) {
    if (!this.cache.exists('hook')) {
      throw new Error('No id given');
    }
    id = this.cache.get('hook');
  }

  var msg = _.defaults({
    id: id
  }, this.config.msg);

  return this.rest.repos.deleteHook(msg);
};


// merge a change event
Metahub.prototype._merge = function (data) {
  data = stripUrl(data);
  var action = data.action;

  var entity = data.comment ?
                  (data.issue ? 'issueComment' : 'pullRequestComment') :
                data.pull_request ? 'pullRequest' :
                data.issue ? 'issue' : '';

  var methodName = entity +
    action[0].toUpperCase() +
    action.substr(1);

  (this['_' + methodName] || function () {}).apply(this, [data]);

  this.emit(methodName, data);
};

// there methods are invoked by merge
// they are applies before event handlers

Metahub.prototype._issueCommentCreated = function (data) {
  this.__commentCreated(data.issue, data.comment);
};

Metahub.prototype._pullRequestCommentCreated = function (data) {
  this.__commentCreated(data.pull_request, data.comment);
};

// issueish = issue or PR
Metahub.prototype.__commentCreated = function (issueish, comment) {
  this.issues[issueish.number].comments[comment.id] = 
    _.merge({}, this.issues[issueish.number].comments[comment.id], comment);
  this._cacheIssues();
};

Metahub.prototype._issueClosed =
Metahub.prototype._issueReopened =
Metahub.prototype._issueOpened = function (data) {
  this.issues[data.issue.number] = _.merge({}, this.issues[data.issue.number], data.issue);
  this._cacheIssues();
};

Metahub.prototype._cacheIssues = function () {
  this.cache.set('issues', this.issues);
};


Metahub.prototype.log = function () {};


module.exports = function (config) {
  return new Metahub(config);
};
