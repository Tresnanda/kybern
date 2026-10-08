(function(){
  var p=window.parent;if(!p||p===window)return;
  var pre=/^\/preview-files\/[^\/]+\//,K="__kb",s,i=0,h=[];
  try{if(name.indexOf(K)===0){s=JSON.parse(name.slice(3));h=s.h;i=s.i}}catch(e){}
  function url(){return location.pathname.replace(pre,"")+location.search+location.hash}
  function save(){try{name=K+JSON.stringify({h:h.slice(-50),i:Math.min(i,49)})}catch(e){}}
  function at(u,d){if(h[i]===u)return;if(h[i-1]===u)i--;else if(h[i+1]===u)i++;else if(d){h=h.slice(0,i+1);h.push(u);i=h.length-1}}
  function post(t){try{p.postMessage({source:"kybern-preview",type:t,path:url(),title:document.title||"",back:i,forward:Math.max(0,h.length-1-i)},"*")}catch(e){}}
  at(url(),1);save();
  ["pushState","replaceState"].forEach(function(k){
    var f=history[k];
    history[k]=function(){var r=f.apply(this,arguments);if(k==="pushState"){h=h.slice(0,i+1);h.push(url());i=h.length-1}else h[i]=url();save();post("nav");return r}
  });
  addEventListener("popstate",function(){at(url(),1);save();post("nav")});
  addEventListener("hashchange",function(){at(url(),1);save();post("nav")});
  addEventListener("pagehide",function(){post("nav-start")});
  addEventListener("DOMContentLoaded",function(){post("nav")});
  addEventListener("message",function(e){
    var d=e.data;
    if(e.source!==p||!d||d.type!=="go")return;
    var n=+d.delta;if(n===n&&n>=-50&&n<=50&&n!==0)history.go(n);
  });
})();
