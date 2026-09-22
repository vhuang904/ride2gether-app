const clone = value => value == null ? value : structuredClone(value);
function memoryStore(entries = {}) {
  const docs = new Map(Object.entries(entries));
  let queue = Promise.resolve();
  let commits = 0;
  return {
    docs, get commits() { return commits; },
    async get(path) { return clone(docs.get(path) || null); },
    atomic(paths, callback) {
      const result = queue.then(() => {
        const writes = new Map();
        const value = callback(path => {
          if (!paths.includes(path)) throw new Error(`Undeclared read: ${path}`);
          return clone(docs.get(path) || null);
        }, (path, data) => writes.set(path, clone(data)));
        if (value?.then) throw new Error("Transaction callback must be synchronous.");
        for (const [path, data] of writes) docs.set(path, data);
        commits++;
        return value;
      });
      queue = result.catch(() => {});
      return result;
    }
  };
}
module.exports = { memoryStore };
