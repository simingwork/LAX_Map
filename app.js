// app.js —— 可拖拽/上传 GeoJSON 的版本
const MAP_STYLE = {
  version: 8,
  sources: {
    basemap: {
      type: "raster",
      // tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tiles:["https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors © CARTO",
    },
  },
  layers: [{ id: "basemap", type: "raster", source: "basemap" }],
};

// UI: 添加隐藏的 <input type="file">
const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".geojson,application/geo+json,application/json";
fileInput.style.display = "none";
document.body.appendChild(fileInput);

// 创建一个提示条（可点击选择文件）
const dropNote = document.createElement("div");
dropNote.style.position = "absolute";
dropNote.style.right = "12px";
dropNote.style.top = "12px";
dropNote.style.background = "rgba(255,255,255,0.92)";
dropNote.style.padding = "8px 10px";
dropNote.style.borderRadius = "8px";
dropNote.style.boxShadow = "0 4px 16px rgba(0,0,0,0.15)";
dropNote.style.fontSize = "12px";
dropNote.innerHTML =
  '💡 如果地图没显示，试试：<button id="pickBtn">选择 GeoJSON</button> 或把 .geojson 拖到页面';
document.body.appendChild(dropNote);
document.getElementById("pickBtn")?.addEventListener("click", () => fileInput.click());

// 拖拽加载
window.addEventListener("dragover", (e) => { e.preventDefault(); });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) readGeoFile(f);
});
// 点击选择加载
fileInput.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) readGeoFile(f);
});

function readGeoFile(file) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const geojson = JSON.parse(ev.target.result);
      init(geojson);
    } catch (err) {
      alert("无法解析该 GeoJSON 文件");
      console.error(err);
    }
  };
  reader.readAsText(file);
}

// 先尝试直接 fetch 同目录文件；失败则等用户拖拽/选择
fetch("west_dsp_polygon.geojson")
  .then((r) => {
    if (!r.ok) throw new Error("fetch failed");
    return r.json();
  })
  .then((geo) => init(geo))
  .catch(() => {
    console.log("直接加载失败，等你拖拽/选择 GeoJSON 文件…");
  });

function init(geojson) {
  // 去重叠加，避免重复初始化
  if (window.__MAP_READY__) return;
  window.__MAP_READY__ = true;

  // 收集分类
  const dspSet = new Set();
  const polySet = new Set();
  for (const f of geojson.features || []) {
    const p = f.properties || {};
    if (p.dsp_name) dspSet.add(String(p.dsp_name));
    if (p.polygon) polySet.add(String(p.polygon));
  }
  const dsps = [...dspSet].sort();
  const polys = [...polySet].sort();

  // 调色板
  const tab20 = ["#1f77b4","#ff7f0e","#2ca02c","#d62728","#9467bd","#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf","#aec7e8","#ffbb78","#98df8a","#ff9896","#c5b0d5","#c49c94","#f7b6d2","#c7c7c7","#dbdb8d","#9edae5"];
  const tab10 = ["#1f77b4","#ff7f0e","#2ca02c","#d62728","#9467bd","#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf"];
  const dsp2color = {}; dsps.forEach((d,i)=> dsp2color[d] = tab20[i % tab20.length]);
  const poly2color = {}; polys.forEach((p,i)=> poly2color[p] = tab10[i % tab10.length]);

  const map = new maplibregl.Map({
    container: "map",
    style: MAP_STYLE,
    center: [-119.5, 36.5],
    zoom: 4.5,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");

  map.on("load", () => {
    map.addSource("zips", { type: "geojson", data: geojson, promoteId: "zipcode" });

    map.addLayer({ id: "zip-fill", type: "fill", source: "zips",
      paint: { "fill-color": "#ccc", "fill-opacity": 0.85 } });
    map.addLayer({ id: "zip-stroke", type: "line", source: "zips",
      paint: { "line-color": "#333", "line-width": 1.2 } });
    
    const dspMatch = ["match", ["get", "dsp_name"]];
    dsps.forEach(d => dspMatch.push(d, dsp2color[d]));
    dspMatch.push("#ccc");
    const fillExpr = [
      "case",
      ["==", ["to-string", ["get", "transferred"]], "是"],
      "#ff0000",   // transferred 专用高亮色
      dspMatch
    ];
    map.setPaintProperty("zip-fill", "fill-color", fillExpr);
    map.setPaintProperty("zip-fill", "fill-opacity", [
      "case",
      ["==", ["to-string", ["get", "transferred"]], "是"],
      0.7,
      0.5
    ]);

    const polyMatch = ["match", ["get", "polygon"]]; polys.forEach(p=>polyMatch.push(p, poly2color[p])); polyMatch.push("#333");
    // map.setPaintProperty("zip-stroke", "line-color", polyMatch);
    map.setPaintProperty("zip-stroke", "line-color", "#000"); // 统一黑色
    map.setPaintProperty("zip-stroke", "line-opacity", 0.7);  // 可选：稍微降一点透明度

    // —— 按 polygon 融合（dissolve），生成外轮廓 ——
    // 先把每个 feature 的属性保留 polygon 字段
    const fc = {
      type: "FeatureCollection",
      features: (geojson.features || []).map(f => ({
        type: "Feature",
        properties: { polygon: String(f.properties?.polygon || "") },
        geometry: f.geometry
      }))
    };
    
    // 用 turf dissolve 按 polygon 字段融合
    let dissolved;
    try {
      dissolved = turf.dissolve(fc, { propertyName: "polygon" });
    } catch (e) {
      console.warn("turf.dissolve 失败，退化为不融合：", e);
      dissolved = fc;
    }
    
    // 加一个新的 source 和 line layer 画 polygon 的“外轮廓”
    map.addSource("polygons-dissolved", { type: "geojson", data: dissolved });
    
    // 多种可读性手段：较粗、虚线、半透明
    map.addLayer({
      id: "polygon-outline",
      type: "line",
      source: "polygons-dissolved",
      paint: {
        "line-color": ["match", ["get", "polygon"],
          // 可继续用你之前的 poly2color 或者直接固定一种颜色
          // 为了不喧宾夺主，建议统一中性颜色，例如深灰
          // 若仍想区分，可用较浅的彩色
          "", "#555", /* default */ "#555"
        ],
        "line-width": 2.5,
        "line-dasharray": [2, 2],
        "line-opacity": 0.8
      }
    });
    
    // （可选）在面心放一个 polygon 文本标签
    map.addLayer({
      id: "polygon-label",
      type: "symbol",
      source: "polygons-dissolved",
      layout: {
        "text-field": ["get", "polygon"],
        "text-size": 11,
        "symbol-placement": "point",
        "text-allow-overlap": false
      },
      paint: {
        "text-halo-color": "#fff",
        "text-halo-width": 1.2,
        "text-color": "#333"
      }
    });
      
    const bounds = new maplibregl.LngLatBounds();
    for (const f of geojson.features || []) {
      const b = bboxFromFeature(f);
      if (b) { bounds.extend([b[0], b[1]]); bounds.extend([b[2], b[3]]); }
    }
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 40 });

    // tooltip
    const tip = document.getElementById("tooltip");
    map.on("mousemove", "zip-fill", (e) => {
      const f = e.features && e.features[0]; if (!f) { tip.style.display="none"; return; }
      const p = f.properties || {};
      tip.style.display = "block";
      tip.style.left = (e.point.x + 8) + "px";
      tip.style.top  = (e.point.y + 8) + "px";
      const transferredText = (p.transferred || "").toString().trim() === "是" ? "是" : "否";
      const pkg = (p.num_package_per_day ?? "") === "" ? "0" : p.num_package_per_day; 
      tip.innerHTML = `
        <b>ZIP:</b> ${p.zipcode || ""}<br>
        <b>DSP:</b> ${p.dsp_name || ""}<br>
        <b>Polygon:</b> ${p.polygon || ""}<br>
        <b>Transferred:</b> ${transferredText}<br>
        <b>num_package_per_day:</b> ${pkg}
      `;
        
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "zip-fill", () => { tip.style.display="none"; map.getCanvas().style.cursor = ""; });

    // 控件
    const width = document.getElementById("strokeWidth");
    width?.addEventListener("input", (ev) => map.setPaintProperty("zip-stroke", "line-width", parseFloat(ev.target.value)));

    const box = document.getElementById("filterText");
    const clear = document.getElementById("clearBtn");
    function apply() {
      const q = (box?.value || "").trim().toLowerCase();
      const numMatch = q.match(/^(>=|<=|>|<|=)\s*(\d+(\.\d+)?)$/);
      if (!q) {
        map.setFilter("zip-fill", null);
        map.setFilter("zip-stroke", null);
        
        if (map.getLayer("zip-transfer-outline")) map.setFilter("zip-transfer-outline", ["==", ["to-string", ["get", "transferred"]], "是"]);
        if (map.getLayer("zip-transfer-symbol")) map.setFilter("zip-transfer-symbol", ["==", ["to-string", ["get", "transferred"]], "是"]);
        return;
      }

      if (numMatch) {
        const op = numMatch[1];
        const num = Number(numMatch[2]);
        
        const expr = [
          op,
          ["to-number", ["get", "num_package_per_day"]],
          num
        ];
        
        map.setFilter("zip-fill", expr);
        map.setFilter("zip-stroke", expr);
        
        const matchedFeatures = (geojson.features || []).filter(f => {
          const v = Number(f.properties?.num_package_per_day);
          if (Number.isNaN(v)) return false;
        
          if (op === ">") return v > num;
          if (op === ">=") return v >= num;
          if (op === "<") return v < num;
          if (op === "<=") return v <= num;
          if (op === "=") return v === num;
          return false;
        });
        
        zoomToFeatures(matchedFeatures);
        return;
      }
        
      const expr = ["any",
        ["in", q, ["downcase", ["to-string", ["get","dsp_name"]]]],
        ["in", q, ["downcase", ["to-string", ["get","polygon"]]]],
        ["in", q, ["downcase", ["to-string", ["get","zipcode"]]]],
        ["in", q, ["downcase", ["to-string", ["get","transferred"]]]],
        ["in", q, ["downcase", ["to-string", ["get","num_package_per_day"]]]],
        ["in", q, ["downcase", ["to-string", ["get","AE_num_package_per_day"]]]],
        ["in", q, ["downcase", ["to-string", ["get","AE_plan_per_day"]]]]
      ];

      map.setFilter("zip-fill", expr);
      map.setFilter("zip-stroke", expr);

      const matchedFeatures = (geojson.features || []).filter(f => {
          const p = f.properties || {};
          const values = [
            p.dsp_name,
            p.polygon,
            p.zipcode,
            p.transferred,
            p.AE_num_package_per_day,
            p.AE_plan_per_day
          ].map(v => String(v ?? "").toLowerCase());

          return values.some(v => v.includes(q));
        });

        zoomToFeatures(matchedFeatures);
        
      if (map.getLayer("zip-transfer-outline")) {
        map.setFilter("zip-transfer-outline", ["all", expr, ["==", ["to-string", ["get", "transferred"]], "是"]]);
      }
      if (map.getLayer("zip-transfer-symbol")) {
        map.setFilter("zip-transfer-symbol", ["all", expr, ["==", ["to-string", ["get", "transferred"]], "是"]]);
      } 
    }
    box?.addEventListener("input", apply);
    function zoomToFeatures(features) {
      if (!features || features.length === 0) return;
    
      const bounds = new maplibregl.LngLatBounds();
    
      for (const f of features) {
        const b = bboxFromFeature(f);
        if (b) {
          bounds.extend([b[0], b[1]]);
          bounds.extend([b[2], b[3]]);
        }
      }
    
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, {
          padding: 80,
          duration: 800,
          maxZoom: 11
        });
      }
    }
    clear?.addEventListener("click", () => { if (box) box.value = ""; apply(); });
  });
}

function bboxFromFeature(f) {
  try {
    const g = f.geometry;
    const coords = (g.type === "Polygon") ? g.coordinates.flat(1)
                : (g.type === "MultiPolygon") ? g.coordinates.flat(2) : null;
    if (!coords) return null;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for (const [x,y] of coords) {
      if (x<minX) minX=x; if (y<minY) minY=y; if (x>maxX) maxX=x; if (y>maxY) maxY=y;
    }
    return [minX,minY,maxX,maxY];
  } catch { return null; }
}
