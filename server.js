var mineos = require('./mineos');
var chokidar = require('chokidar');
var path = require('path');
var events = require('events');
var tail = require('tail').Tail;
var server = exports;

server.extract_server_name = function(base_dir, server_path) {
  var re = new RegExp('{0}/([a-zA-Z0-9_\.]+)'.format(path.join(base_dir, mineos.DIRS['servers'])));
  try {
    return re.exec(server_path)[1];
  } catch(e) {
    throw new Error('no server name in path');
  }
}

server.backend = function(base_dir, socket_emitter) {
  var self = this;
  self.servers = {};
  self.namespaces = {};
  self.base_dir = base_dir;
  self.front_end = socket_emitter || new events.EventEmitter();

  self.front_end.on('connection', function(socket) {
    console.info('User connected');
    socket.emit('server_list', Object.keys(self.servers));

    socket.on('create', function(server_name) {
      var instance = new mineos.mc(server_name, self.base_dir);
      instance.create(function(did_create) {
        if (did_create){
          console.info('Server created: {0}'.format(server_name));
        }
      })
    })
  })

  self.watcher_server_list = chokidar.watch(path.join(self.base_dir, mineos.DIRS['servers']),
                                            {persistent: true});

  self.watcher_server_list.on('addDir', function(newpath) {
    try {
      var server_name = server.extract_server_name(self.base_dir, newpath);
    } catch (e) {
      return;
    }

    if (!(server_name in self.servers)) {
      var instance = new mineos.mc(server_name, self.base_dir);
      instance.is_server(function(is_server) {
        if (is_server) {
          self.create_server_namespace(server_name);
          self.servers[server_name] = instance;
          console.info('Discovered server: {0}'.format(server_name));
        }
      })
    }
  })

  self.watcher_server_list.on('unlinkDir', function(newpath) {
    try {
      var server_name = server.extract_server_name(newpath);
    } catch (e) {
      return;
    }

    delete self.namespaces[server_name];
    delete self.servers[server_name];
    console.info('Server removed: {0}'.format(server_name));
    self.front_end.emit('server_list', Object.keys(self.servers));
  })

  self.create_server_namespace = function(server_name) {
    self.namespaces[server_name] = self.front_end.of('/{0}'.format(server_name));
    var nsp = self.namespaces[server_name];

    nsp.on('connection', function(socket) {
      socket.on('start', function() {
        self.servers[server_name].start(function(did_start) {
          if (did_start){
            console.info('Server started: {0}'.format(server_name));
          }
        })
      })

      socket.on('server_overview', function() {
        self.servers[server_name].sp(function(sp_data) {
          nsp.emit('server.properties', sp_data);
        })
      })

      socket.on('stuff', function(msg) {
        self.servers[server_name].stuff(msg, function(did_stuff, proc) {
          if (did_stuff){
            console.info('Server {0} sent command: {1}'.format(server_name, msg));
          } else {
            console.warn('Ignored attempt to send "{0}" to {1}'.format(msg, server_name));
          }
        })
      })

      socket.on('start_tail', function(fp) {
        var file_path = path.join(self.servers[server_name].env.cwd, fp);
        var room = fp;
        socket.join(room);

        console.info('Creating tail "{0}" on {1}'.format(room, file_path));
        var ft = new tail(file_path);

        ft.on("line", function(data) {
          nsp.in(room).emit('tail_data', data);
        })
        
        socket.on('disconnect', function() {
          ft.unwatch();
          console.info('Dropping tail: {0}'.format(room));
        })
      })

    })



  }

  return self;
}

String.prototype.format = function() {
  var s = this;
  for(var i = 0, iL = arguments.length; i<iL; i++) {
    s = s.replace(new RegExp('\\{'+i+'\\}', 'gm'), arguments[i]);
  }
  return s;
};
