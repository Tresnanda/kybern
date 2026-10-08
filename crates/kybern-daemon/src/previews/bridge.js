(function(){
  var p=window.parent;if(!p||p===window)return;
  var pre=/^\/preview-files\/[^\/]+\//;
  function rel(){return location.pathname.replace(pre,"")+location.search+location.hash}
  function post(t){try{p.postMessage({source:"kybern-preview",type:t,path:rel(),title:document.title||""},"*")}catch(e){}}
  ["pushState","replaceState"].forEach(function(k){
    var f=history[k];
    history[k]=function(){var r=f.apply(this,arguments);post("nav");return r}
  });
  addEventListener("popstate",function(){post("nav")});
  addEventListener("hashchange",function(){post("nav")});
  addEventListener("pagehide",function(){post("nav-start")});
  addEventListener("beforeunload",function(){post("nav-start")});
  addEventListener("DOMContentLoaded",function(){post("nav")});
  addEventListener("message",function(e){
    var d=e.data;
    if(e.source!==p||!d||d.type!=="go")return;
    var n=+d.delta;if(n===n&&n>=-50&&n<=50&&n!==0)history.go(n);
  });
})();
