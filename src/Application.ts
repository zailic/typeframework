/// <reference path="TypeFramework.ts" />

module TF {
    export class Application {
        config: Configuration;
        router: Router;
        root: string;

        protected express: EX.Application;
        private declaration: Declaration;
        private models: ModelInfo[] = [];
        private controllers: ControllerInfo[] = [];

        constructor(root: string) {
            this.root = root;
            this.config = new Configuration(root);
            this.router = new Router();

            // default settings
            this.config.set('env', !process.env.NODE_ENV ? 'development' : process.env.NODE_ENV);
            this.config.set('port', 3000);
            this.config.set('assetPath', 'public');
            this.config.set('view.path', 'app/views');
            this.config.set('view.engine', 'ejs');
            this.config.set('view.layout', false);
        }

        public configure(callback: () => void) {
            callback.call(this);
        }

        public addDeclaration(filePath: string) {
            this.declaration = new Declaration(path.join(this.root, filePath));
        }

        public addController(controller: any) {
            if (controller.hasOwnProperty('configure'))
                controller.configure();

            var info = new ControllerInfo(controller, this.declaration);
            this.controllers.push(info);
        }

        public addModel(model: any) {
            if (model.hasOwnProperty('configure'))
                model.configure();

            var info = new ModelInfo(model, this.declaration);
            this.models.push(info);
        }

        public start() {
            this.buildExpress();
            this.buildCollections();
            this.buildRoutes();

            var port = this.config.get('port');
            this.express.listen(port);
            console.log('Listening on port: ' + port);
        }

        protected buildExpress() {
            var express: any = require('express');
            this.express = express();
            this.express.set('views', path.join(this.root, this.config.get('view.path')));
            this.express.set('view engine', this.config.get('view.engine'));
            this.express.set('layout', this.config.get('view.layout'));

            // add compression middleware
            this.express.use(require('compression')());

            // add logging middleware
            var debugFormat = this.config.get('logging.format');
            if (!!debugFormat)
                this.express.use(require('morgan')(debugFormat));

            // add body parser middleware
            var bodyParser: any = require('body-parser');
            this.express.use(bodyParser.urlencoded({ extended: true }));
            this.express.use(bodyParser.json());

            // add ejs layout middleware
            this.express.use(require('express-ejs-layouts'));
        }

        private buildCollections() {
            var Waterline = <WL.Waterline> require('waterline');
            var adapterNames = Object.getOwnPropertyNames(this.config.get('adapters'));
            var root = path.resolve(this.root);
            while (true) {
                if (fs.existsSync(path.resolve(root, 'node_modules'))) break;
                if (root == '/') break;
                root = path.resolve(root, '..');
            }

            var adapterObjects = _.map(adapterNames, (adapterName: string) => {
                var settings = this.config.get('adapters.' + adapterName);
                var adapter = require(path.join(root, 'node_modules', settings.module));

                extend(adapter, settings);
                adapter.schema = adapter.schema || true;
                adapter.filePath && (adapter.filePath = path.join(this.root, adapter.filePath));
                return adapter;
            });
            var adapters = _.object(adapterNames, adapterObjects);

            this.models.forEach((model: ModelInfo) => {
                var typeClass = model.type.prototype.constructor;
                var attributes = typeClass['attributes'] || {};
                model.properties.forEach((attr: MemberInfo) => {
                    var name = attr.name;
                    if (!attributes.hasOwnProperty(name))
                        attributes[name] = {};

                    if (!attributes[name].hasOwnProperty('type'))
                        attributes[name]['type'] =
                                attr.type == 'boolean' ? 'boolean' :
                                attr.type == 'number' ? 'integer' : 'string';

                    if (!attributes[name].hasOwnProperty('required'))
                        attributes[name].required = true;
                });

                var adapterName = typeClass['adapter'] || 'default';
                var adapter = adapters[adapterName];
                var definition = {
                    adapter: adapterName,
                    schema: typeClass['schema'] || adapter.schema,
                    tableName: typeClass['collectionName'] || model.name.toLowerCase(),
                    attributes: attributes
                };

                var Collection = Waterline.Collection.extend(definition);
                new Collection({ adapters: { 'default': adapter } }, (err, collection) => {
                    model.type.prototype.constructor['collection'] = collection;
                });
            });
        }

        private buildRoutes() {
            // public folder
            var expressStatic: any = require('express').static;
            this.express.use(expressStatic(path.join(this.root, this.config.get('assetPath'))));

            // routes
            this.router.routes.forEach((route: Route) => {
                this.route(route);
            });

            // error handler
            var custom500 = this.express.get('views') + '/500.ejs';
            if (fs.existsSync(custom500))
                this.express.use((error, req, res, next) => {
                     res.render(500, '500');
                });
            else
                this.express.use((error: Error, req: EX.Request, res: EX.Response, next) => {
                    fs.readFile(__dirname + '/../views/500.html', { encoding: 'utf8' }, (err, data) => {
                        if (err) res.send(500, 'Server Error');
                        else if (this.config.get('env') == 'development')
                            res.send(500, data
                                .replace(/{{name}}/g, error.name)
                                .replace('{{message}}', error.message)
                                .replace('{{stack}}', error['stack']));
                        else
                            res.send(500, data
                                .replace(/{{name}}/g, 'Server Error')
                                .replace('{{message}}', 'The server has encountered an internal error.')
                                .replace('{{stack}}', ''));
                    });
                });

            // not found
            var custom404 = this.express.get('views') + '/404.ejs';
            if (fs.existsSync(custom404))
                this.express.use((req, res) => {
                    res.render(404, '404');
                });
            else
                this.express.use((req: EX.Request, res: EX.Response) => {
                    fs.readFile(__dirname + '/../views/404.html', { encoding: 'utf8' }, (err, data) => {
                        if (err) res.send(404, 'Not found');
                        else res.send(404, data);
                    });
                });
        }

        private route(route: Route) {
            var action = (req: EX.Request, res: EX.Response, next: Function) => {
                res.header('X-Powered-By', 'TypeFramework');

                var controllerName = req.params.controller || route.defaults.controller;
                if (!controllerName) {
                    next(); return;
                }

                var controllerInfo = _.find<ControllerInfo>(this.controllers, (x: ControllerInfo) => x.name == controllerName.toLowerCase());
                if (!controllerInfo) {
                    next(); return;
                }

                var actionName = req.params.action || route.defaults.action;
                var actionInfo = controllerInfo.getAction(actionName);
                if (!actionInfo) {
                    next(); return;
                }

                if (_.any(actionInfo.keywords, (x) => _.contains(['static', 'private'], x))) {
                    next(); return;
                }

                var params = actionInfo.parameters.map(paramInfo => {
                    var name = paramInfo.name;
                    var paramData = req.param(name) || route.defaults[name];
                    if (!!paramInfo) {
                        if (_.contains(paramInfo.type, '[]') && !(paramData instanceof Array))
                            paramData = [paramData];

                        switch (paramInfo.type) {
                            case 'boolean':
                                return !!paramData && (paramData == '1' || paramData == 'true');
                            case 'boolean[]':
                                return paramData.map((data) => !!data && (data == '1' || data == 'true'));
                            case 'number':
                                var num = Number(paramData);
                                if (isNaN(num)) throw new Error('Cannot parse number for param: ' + name);
                                return num;
                            case 'number[]':
                                return paramData.map((data) => {
                                    var num = Number(data);
                                    if (isNaN(num)) throw new Error('Cannot parse number for param: ' + name);
                                    return num;
                                });
                        }
                    }
                    return paramData;
                });

                var response = new Response(res);
                var result: IActionResult = null;

                // generate after action filter chain
                var complete = () => { result.execute(this, response) };
                var afterActionChain = _.reduce(controllerInfo.type.filters || [], (next, filter: ActionFilter) => {
                    if (!filter['after'] || !filter.contains(actionName)) return next;
                    return function() {
                        filter['after'].call(filter, {
                            request: req,
                            response: response,
                            result: result,
                            reply: new Reply((actionResult: IActionResult) => { result = actionResult; complete(); }),
                            next: next });
                    };
                }, complete);

                // result will action will be executed when controller finish executing controller action
                var resultAction = (actionResult: IActionResult) => {
                    result = actionResult;
                    afterActionChain();
                };

                // generate controller
                var controller = new controllerInfo.type(req, response, resultAction);
                var controllerAction = () => { controller[actionName].apply(controller, params) };

                // generate model controller actions if has model
                if (!!controllerInfo.type.model) {
                    var modelController = new ModelController(req, response, resultAction, controllerInfo.type.model);
                    controller._model = modelController._model;
                    !controller.find && (controller.find = modelController.find);
                    !controller.create && (controller.create = modelController.create);
                    !controller.update && (controller.update = modelController.update);
                    !controller.destroy && (controller.destroy = modelController.destroy);
                }

                // generate before action filter chain
                var chain = _.reduceRight(controllerInfo.type.filters || [], (next, filter: ActionFilter) => {
                    if (!filter['before'] || !filter.contains(actionName)) return next;
                    return function() {
                        filter['before'].call(filter, {
                            request: req,
                            response: response,
                            reply: new Reply((actionResult: IActionResult) => { result = actionResult; complete(); }),
                            next: next });
                    };
                }, controllerAction);

                chain();
            };

            // map routes
            var eRoute = this.express.route(route.path);
            ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].forEach((method) => {
                if (!_.contains(route.methods, method)) return;
                var map: Function = eRoute[method.toLowerCase()];
                map.call(eRoute, action);
            });
        }
   }
}