// src/platform/modelRegistry.js
//
// Models that resolve to "the current gym's database" at the moment they are
// used.
//
// A mongoose model is bound to one connection when it is compiled. With one
// database per gym there is one compiled model per gym per schema, and the
// right one depends on which request is running. Rather than have every
// controller ask for the model by connection, each model file exports a proxy
// that looks exactly like the model it always did -- `User.find()`,
// `new User()`, `User.schema` -- and forwards to the compiled model on the
// connection in the current tenant context.
//
// The schemas are also kept in a registry so a new connection can have every
// model compiled on it up front. That matters for populate(): a `ref: 'User'`
// is resolved by name on the connection, and would fail if the User model had
// not been touched yet on that connection.

const { currentConnection } = require('./tenantContext');

const TENANT_MODEL = Symbol.for('gympilot.tenantModel');

const registry = new Map(); // model name -> schema

function ensureModelsOn(connection) {
  for (const [name, schema] of registry) {
    if (!connection.models[name]) connection.model(name, schema);
  }
  return connection;
}

function registeredModelNames() {
  return Array.from(registry.keys());
}

// Properties a proxy may be asked for while no tenant is in context -- by a
// logger, a debugger, or `await` probing for a thenable. Answering undefined
// for those is right; throwing would turn a console.log into a crash.
function isProbe(prop) {
  return typeof prop === 'symbol' || prop === 'then' || prop === 'inspect' || prop === 'toJSON';
}

function lazyModel(name, schema, resolveConnection, describe) {
  const resolve = () => {
    const connection = resolveConnection();
    if (!connection) {
      throw new Error(
        `[tenant] Model "${name}" was used outside a ${describe} context. ` +
          'HTTP requests get one from resolveTenant; jobs and scripts must wrap their work in runWithTenant() / enterTenant().'
      );
    }
    return connection.models[name] || connection.model(name, schema);
  };

  const handler = {
    get(_target, prop) {
      if (prop === TENANT_MODEL) return name;
      if (prop === 'modelName') return name;
      if (isProbe(prop) && !resolveConnection()) return undefined;
      const model = resolve();
      const value = model[prop];
      return typeof value === 'function' ? value.bind(model) : value;
    },
    set(_target, prop, value) {
      resolve()[prop] = value;
      return true;
    },
    has(_target, prop) {
      return prop in resolve();
    },
    construct(_target, args) {
      const Model = resolve();
      return new Model(...args);
    },
    apply(_target, _thisArg, args) {
      const Model = resolve();
      return Model(...args);
    },
    getPrototypeOf() {
      const connection = resolveConnection();
      return connection ? Object.getPrototypeOf(resolve()) : Function.prototype;
    }
  };

  // The target is a function so the proxy supports both `new` and calls.
  return new Proxy(function LazyModel() {}, handler);
}

/**
 * Registers a schema and returns a proxy to its per-gym model.
 *
 *   module.exports = tenantModel('User', userSchema);
 */
function tenantModel(name, schema) {
  if (!registry.has(name)) registry.set(name, schema);
  return lazyModel(name, schema, currentConnection, 'tenant');
}

module.exports = {
  TENANT_MODEL,
  tenantModel,
  lazyModel,
  ensureModelsOn,
  registeredModelNames
};
