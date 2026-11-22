#!/bin/sh
set -e
cd "$(dirname "$0")"
OUT=index.html

{
  cat src/head.html
  echo '<script>if(!window.L){document.addEventListener("DOMContentLoaded",function(){document.body.innerHTML="<p style=\"padding:24px;font:16px sans-serif\">The map library could not be loaded. This tool needs an internet connection (it loads Leaflet and live imagery services).</p>";});throw new Error("Leaflet missing");}</script>'
  echo '<script>'
  cat src/core.js src/infer.js
  echo '</script>'
  echo '<script>'
  cat src/app1.js src/app2.js src/auto.js
  echo '</script>'
  echo '</body>'
  echo '</html>'
} > $OUT
wc -c $OUT
