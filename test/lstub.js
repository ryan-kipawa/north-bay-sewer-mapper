(function(){
  const calls = window.__Lcalls = [];
  function mk(path){
    const fn = function(){};
    return new Proxy(fn, {
      get(t, p){
        if (p === Symbol.toPrimitive) return () => 0;
        if (p === 'then') return undefined;
        if (p === Symbol.iterator) return function*(){};
        if (p === 'length') return 0;
        if (typeof p === 'symbol') return undefined;
        if (!(p in t)) t[p] = mk(path + '.' + String(p));
        return t[p];
      },
      set(t, p, v){ t[p] = v; return true; },
      apply(t, self, args){ calls.push(path); return mk(path + '()'); },
      construct(t, args){ calls.push('new ' + path); return mk('new ' + path); }
    });
  }
  window.L = mk('L');
})();
