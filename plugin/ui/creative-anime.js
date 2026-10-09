// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// Four original, flat-painted landscapes. All motion comes from the stage clock;
// the registry owns their parameters, camera and navigation illustrations.
(function () {
  'use strict';

  var VERT = `
out vec2 vUV;
void main() {
  const vec2 corners[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(1,1),
    vec2(-1,-1), vec2(1,1), vec2(-1,1));
  vec2 p = corners[gl_VertexID];
  vUV = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

  // Distances are in a 1600 x 900 drawing. The view crops naturally on narrow
  // screens, while the focal subjects remain near the centre. Only distant
  // silhouettes use soft edges; foreground ink remains at drawing resolution.
  var PAINT = `
in vec2 vUV;
out vec4 frag;
float aa;
const vec3 ink = vec3(0.105, 0.155, 0.285);
const vec3 cream = vec3(0.98, 0.951, 0.863);
float ellipse(vec2 p, vec2 r) { return (length(p / r) - 1.0) * min(r.x, r.y); }
float box(vec2 p, vec2 r) {
  vec2 q = abs(p) - r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
float segment(vec2 p, vec2 a, vec2 b) {
  vec2 v = b - a;
  return length(p - a - v * clamp(dot(p - a, v) / dot(v, v), 0.0, 1.0));
}
float cover(float d) { return 1.0 - smoothstep(-aa, aa, d); }
vec3 paint(vec3 c, float d, vec3 color) { return mix(c, color, cover(d)); }
vec3 softPaint(vec3 c, float d, float blur, vec3 color) {
  return mix(c, color, 1.0 - smoothstep(-blur, blur, d));
}
vec3 outline(vec3 c, float d, vec3 color, vec3 edge) {
  c = paint(c, d - 1.7, edge);
  return paint(c, d, color);
}
vec2 drawing() {
  vec2 p = (vec2(vUV.x, 1.0 - vUV.y) - 0.5) * vec2(uRes.x / uRes.y, 1.0) * 900.0;
  float c = cos(uFrame.w), s = sin(uFrame.w);
  p = mat2(c, -s, s, c) * p;
  p = p * uFrame.z + uFrame.xy + vec2(800.0, 450.0);
  aa = max(0.65, 620.0 / uRes.y) * uFrame.z;
  return p;
}
float grain(vec2 p) {
  vec3 q=fract(vec3(p.xyx)*0.1031);
  q+=dot(q,q.yzx+33.33);
  return fract((q.x+q.y)*q.z);
}
vec3 finishPaint(vec3 c, vec2 p) {
  // A fixed 6.5% paper layer, not animated film noise.
  c = mix(c, c * (0.62 + 0.72 * grain(floor(gl_FragCoord.xy))), 0.065);
  return clamp(c * uPaint.x, 0.0, 1.0);
}
float cloudShape(vec2 q) {
  float d = ellipse(q - vec2(0,-20), vec2(137,80));
  d = min(d, ellipse(q - vec2(-142, 14), vec2(93, 35)));
  d = min(d, ellipse(q - vec2(-170,-5), vec2(46,39)));
  d = min(d, ellipse(q - vec2(-101,-33), vec2(60,56)));
  d = min(d, ellipse(q - vec2(-52,-82), vec2(52,63)));
  d = min(d, ellipse(q - vec2(-23,-136), vec2(32,37)));
  d = min(d, ellipse(q - vec2(21,-122), vec2(46,59)));
  d = min(d, ellipse(q - vec2(59,-103), vec2(29,35)));
  d = min(d, ellipse(q - vec2(91,-69), vec2(47,53)));
  d = min(d, ellipse(q - vec2(134,-28), vec2(48,50)));
  d = min(d, ellipse(q - vec2(167,6), vec2(57,32)));
  d = min(d, ellipse(q - vec2(199,21), vec2(47,23)));
  d = min(d, ellipse(q - vec2(107,39), vec2(87,23)));
  d = min(d, ellipse(q - vec2(13,42), vec2(82,21)));
  d = min(d, ellipse(q - vec2(-75,38), vec2(65,23)));
  return d + sin(q.x*0.31+q.y*0.17)*0.32 + sin(q.x*0.12-q.y*0.26)*0.24;
}
vec3 cloud(vec3 c, vec2 p, vec2 at, float size, vec3 lit, vec3 shadow, float phase) {
  at.x += sin(uTime * 0.055 * uPaint.y + phase) * 18.0;
  vec2 q = (p - at) / size;
  q.x += sin(q.y * 0.014 + phase) * 10.0;
  q.y += sin(q.x * 0.012 + phase) * 4.0;
  float d = cloudShape(q);
  lit *= 1.0 + uAgg.x * 0.018;
  float cut = q.y + 12.0 + 15.0 * sin(q.x * 0.023 + phase) + 5.0 * sin(q.x * 0.069);
  vec3 fill = mix(lit, shadow, smoothstep(-0.8, 0.8, cut) * (0.64 + uPaint.z * 0.3));
  // Small stepped shadow shelves describe the cloud lobes without airbrushing.
  float shelves = max(ellipse(q-vec2(-91,-41),vec2(40,17)),-ellipse(q-vec2(-85,-50),vec2(41,20)));
  shelves = min(shelves,max(ellipse(q-vec2(41,-69),vec2(45,17)),-ellipse(q-vec2(46,-78),vec2(45,20))));
  shelves = min(shelves,max(ellipse(q-vec2(-19,-117),vec2(22,10)),-ellipse(q-vec2(-16,-122),vec2(24,11))));
  shelves = min(shelves,max(ellipse(q-vec2(121,-21),vec2(38,13)),-ellipse(q-vec2(128,-28),vec2(39,15))));
  fill = mix(fill,mix(lit,shadow,0.48),cover(shelves)*cover(d+7.0));
  float base = min(ellipse(q-vec2(-90,23),vec2(55,9)),ellipse(q-vec2(64,30),vec2(70,7)));
  fill = mix(fill,shadow*0.96,cover(base)*0.48);
  vec3 edge = mix(shadow, ink, 0.10);
  c = outline(c, d * size, fill, edge);
  float rim = cover(abs(d + 3.0) - 1.0) * cover(q.y + 30.0);
  return mix(c, lit, rim * 0.52);
}
float ridge(float x, float phase) {
  return sin(x * 0.005 + phase) * 22.0 + sin(x * 0.013 + phase * 2.0) * 9.0
    + sin(x * 0.028 + phase) * 3.0;
}
vec3 gull(vec3 c, vec2 p, vec2 at, float size, vec3 color) {
  vec2 q = (p - at) / size;
  float d = min(segment(q, vec2(-14,-4), vec2(0,0)), segment(q, vec2(0,0), vec2(13,-6)));
  return paint(c, d * size - 1.0, color);
}
float scatter(float n) { return hash11(n + uSeed * 37.0); }
vec3 stars(vec3 c, vec2 p, float brightness) {
  for (int i = 0; i < 36; i++) {
    float fi = float(i);
    vec2 at = vec2(90.0 + scatter(fi * 7.1 + 1.2) * 1420.0, 48.0 + scatter(fi * 12.7 + 4.0) * 432.0);
    float r = 0.7 + scatter(fi + 2.0) * 1.15;
    float glow = brightness * (0.58 + 0.16 * sin(uTime * 0.32 * uPaint.y + fi));
    c = mix(c, cream, cover(length(p - at) - r) * glow);
  }
  return c;
}
`;

  var SKY = `
void main() {
  vec2 p = drawing();
  vec3 c = mix(vec3(0.115,0.24,0.56), vec3(0.50,0.78,0.87), smoothstep(0.0,690.0,p.y));
  float sun = length(p - vec2(1070,238));
  c = mix(c, vec3(0.86,0.89,0.80), exp(-sun * sun / 170000.0) * 0.13);
  c = paint(c, sun - 34.0, cream);
  // A broad distant cloud bank, softened only by atmospheric depth.
  c = softPaint(c, 609.0 + ridge(p.x,2.1) * 0.42 - p.y, 3.5, vec3(0.69,0.79,0.85));
  c = cloud(c,p,vec2(1203,395),1.35,cream,vec3(0.49,0.65,0.85),0.8);
  c = cloud(c,p,vec2(247,356),0.79,vec3(0.95,0.95,0.88),vec3(0.55,0.68,0.84),2.4);
  c = cloud(c,p,vec2(566,555),0.43,vec3(0.87,0.91,0.88),vec3(0.60,0.72,0.82),4.5);
  c = cloud(c,p,vec2(1492,538),0.53,vec3(0.86,0.90,0.90),vec3(0.58,0.71,0.84),2.1);
  // Thin cloud trails give the large open sky a direction.
  c = paint(c, ellipse(p - vec2(810,187),vec2(108,1.5)), vec3(0.68,0.81,0.87));
  c = paint(c, ellipse(p - vec2(702,203),vec2(56,1.0)), vec3(0.68,0.81,0.87));
  c = softPaint(c, 667.0 + ridge(p.x,0.2) * 1.6 - p.y, 2.4, vec3(0.35,0.53,0.64));
  c = outline(c, 728.0 + ridge(p.x,2.2) * 1.3 - p.y, vec3(0.22,0.41,0.49),vec3(0.25,0.40,0.52));
  // Small hillside roofs; the skyline never competes with the lyric area.
  for (int i=0;i<13;i++) {
    float n=float(i), x=100.0+n*117.0+scatter(n*7.0)*27.0, y=743.0+ridge(x,2.2)*0.9;
    vec2 q=p-vec2(x,y);
    float house=box(q-vec2(0,16),vec2(15.0+mod(n,3.0)*4.0,19));
    c=outline(c,house,vec3(0.69,0.76,0.72),vec3(0.21,0.36,0.44));
    float roof=max(abs(q.x)*0.55-q.y-6.0,q.y-5.0);
    c=paint(c,roof,vec3(0.27,0.39,0.50));
    c=paint(c,box(q-vec2(5,15),vec2(3,5)),vec3(0.96,0.86,0.63));
    c=paint(c,box(q-vec2(-7,28),vec2(3,7)),vec3(0.33,0.49,0.52));
  }
  c=outline(c,827.0+ridge(p.x,3.1)*1.2-p.y,vec3(0.11,0.27,0.35),ink);
  // Foreground wires and grasses have a crisp two-tone line.
  float wireY=177.0+0.000029*(p.x-250.0)*(p.x-250.0);
  c=paint(c,abs(p.y-wireY)-0.7,vec3(0.23,0.33,0.46));
  c=paint(c,abs(p.y-wireY-15.0)-0.6,vec3(0.26,0.36,0.49));
  c=paint(c,box(p-vec2(1452,490),vec2(5,295)),ink);
  c=paint(c,segment(p,vec2(1418,212),vec2(1488,212))-3.0,ink);
  for (int i=0;i<22;i++) {
    float n=float(i), x=n*80.0-45.0, y=840.0+ridge(x,3.1);
    float sway=sin(uTime*0.36*uPaint.y+n)*3.0;
    c=paint(c,segment(p,vec2(x,y+44.0),vec2(x+12.0+sway,y-17.0))-1.4,vec3(0.27,0.42,0.38));
    c=paint(c,segment(p,vec2(x+5.0,y+10.0),vec2(x-7.0+sway,y-1.0))-1.0,vec3(0.34,0.49,0.41));
    c=paint(c,segment(p,vec2(x+9.0,y-1.0),vec2(x+23.0+sway,y-8.0))-1.0,vec3(0.34,0.49,0.41));
  }
  c=gull(c,p,vec2(855,325),0.8,vec3(0.30,0.42,0.57));
  c=gull(c,p,vec2(826,349),0.55,vec3(0.37,0.49,0.62));
  frag=vec4(finishPaint(c,p),1.0);
}`;

  var COAST = `
void main() {
  vec2 p=drawing();
  vec3 c=mix(vec3(0.24,0.24,0.46),vec3(0.96,0.66,0.46),smoothstep(0.0,568.0,p.y));
  float sun=length(p-vec2(1010,444));
  c=mix(c,vec3(1.0,0.80,0.58),exp(-sun*sun/110000.0)*0.10);
  c=paint(c,sun-48.0,vec3(0.99,0.90,0.70));
  c=cloud(c,p,vec2(275,367),0.91,vec3(0.95,0.78,0.66),vec3(0.54,0.51,0.66),1.6);
  c=cloud(c,p,vec2(1205,254),0.72,vec3(0.89,0.74,0.71),vec3(0.50,0.49,0.65),3.5);
  c=paint(c,ellipse(p-vec2(807,518),vec2(129,2.3)),vec3(0.99,0.80,0.58));
  vec3 water=mix(vec3(0.41,0.49,0.64),vec3(0.13,0.26,0.43),smoothstep(554.0,920.0,p.y));
  c=paint(c,554.0-p.y,water);
  c=paint(c,abs(p.y-554.0)-1.2,vec3(0.93,0.72,0.52));
  // Broken, flat ribbons of sunset on the water, never a bloom column.
  for (int i=0;i<26;i++) {
    float n=float(i), y=563.0+n*3.0+n*n*0.34;
    float width=12.0+n*2.2+sin(n*2.4)*13.0;
    float x=1010.0+sin(n*1.73+uTime*0.36*uPaint.y)*13.0;
    float d=box(p-vec2(x,y),vec2(width,0.8+n*0.05));
    c=paint(c,d,mix(vec3(0.97,0.79,0.55),vec3(0.54,0.61,0.65),n/32.0));
    c=paint(c,box(p-vec2(x+width+11.0,y+3.0),vec2(4.0+scatter(n)*12.0,0.7)),vec3(0.76,0.67,0.55));
  }
  for (int i=0;i<29;i++) {
    float n=float(i), x=scatter(n*6.8+2.0)*1800.0-100.0;
    float y=583.0+scatter(n*2.7)*296.0;
    x+=sin(uTime*0.25*uPaint.y+n)*9.0;
    float line=ellipse(p-vec2(x,y),vec2(23.0+scatter(n)*49.0,0.9));
    c=mix(c,vec3(0.57,0.65,0.73),cover(line)*(0.38+uPaint.z*0.42));
  }
  float island=max(ellipse(p-vec2(148,630),vec2(350,74)),p.y-606.0);
  c=softPaint(c,island,1.4,vec3(0.24,0.32,0.47));
  // A distant lighthouse and its narrow amber window.
  c=paint(c,box(p-vec2(307,551),vec2(8,22)),vec3(0.71,0.64,0.62));
  c=paint(c,box(p-vec2(307,527),vec2(12,3)),vec3(0.28,0.34,0.49));
  c=paint(c,box(p-vec2(307,532),vec2(5,3)),vec3(0.98,0.82,0.55));
  c=paint(c,max(abs(p.x-307.0)*0.45-p.y+517.0,p.y-524.0),vec3(0.29,0.34,0.48));
  float shore=795.0+sin(p.x*0.003+0.5)*72.0+sin(p.x*0.007)*14.0;
  c=outline(c,shore-p.y,vec3(0.19,0.24,0.37),ink);
  c=paint(c,abs(p.y-shore+7.0)-1.0,vec3(0.56,0.52,0.54));
  // The sea wall is cropped at the edge, keeping the centre open.
  vec2 q=p-vec2(1410,720);
  c=paint(c,box(q-vec2(0,50),vec2(4,150)),ink);
  c=paint(c,box(q-vec2(120,50),vec2(4,150)),ink);
  c=paint(c,segment(p,vec2(1370,674),vec2(1670,734))-2.2,vec3(0.18,0.23,0.35));
  c=paint(c,segment(p,vec2(1370,715),vec2(1670,775))-1.3,vec3(0.23,0.28,0.41));
  for (int i=0;i<18;i++) {
    float n=float(i), x=85.0+n*20.0, y=845.0+sin(n)*21.0;
    float wind=sin(uTime*0.36*uPaint.y+n)*4.0;
    c=paint(c,segment(p,vec2(x,y+70.0),vec2(x+19.0+wind,y-31.0))-1.7,ink);
    c=paint(c,ellipse(p-vec2(x+18.0+wind,y-33.0),vec2(2,12)),vec3(0.37,0.35,0.42));
  }
  c=gull(c,p,vec2(764,358),1.2,vec3(0.36,0.37,0.52));
  c=gull(c,p,vec2(809,384),0.7,vec3(0.40,0.40,0.54));
  frag=vec4(finishPaint(c,p),1.0);
}`;

  var RAIL = `
void main() {
  vec2 p=drawing();
  vec3 c=mix(vec3(0.065,0.105,0.27),vec3(0.33,0.44,0.61),smoothstep(0.0,655.0,p.y));
  c=stars(c,p,0.32+uPaint.z*0.70);
  float moon=length(p-vec2(1050,210));
  c=mix(c,vec3(0.69,0.74,0.74),exp(-moon*moon/26000.0)*0.06);
  c=outline(c,moon-43.0,vec3(0.92,0.91,0.78),vec3(0.58,0.66,0.75));
  c=mix(c,vec3(0.74,0.80,0.79),cover(ellipse(p-vec2(1069,189),vec2(27,28)))*cover(moon-44.0)*0.20);
  c=cloud(c,p,vec2(355,365),0.88,vec3(0.44,0.52,0.69),vec3(0.27,0.34,0.53),4.2);
  c=cloud(c,p,vec2(1306,471),0.64,vec3(0.49,0.55,0.69),vec3(0.32,0.39,0.57),1.5);
  c=softPaint(c,548.0+ridge(p.x,2.8)*1.7-p.y,3.0,vec3(0.28,0.37,0.54));
  c=softPaint(c,594.0+ridge(p.x,0.2)-p.y,1.5,vec3(0.20,0.29,0.45));
  c=paint(c,624.0-p.y,mix(vec3(0.19,0.30,0.46),vec3(0.105,0.18,0.33),clamp((p.y-624.0)/280.0,0.0,1.0)));
  for(int i=0;i<25;i++) {
    float n=float(i), y=635.0+n*10.0;
    float x=1050.0+sin(n*4.9+uTime*0.20*uPaint.y)*15.0;
    c=mix(c,vec3(0.63,0.71,0.71),cover(box(p-vec2(x,y),vec2(19.0+n*2.4,0.9)))*0.43);
  }
  // Low trestle, drawn as silhouettes. No perspective extrusion or 3D lighting.
  float track=731.0-(p.x-800.0)*0.035;
  c=outline(c,abs(p.y-track)-4.0,vec3(0.26,0.35,0.45),ink);
  c=paint(c,abs(p.y-track-14.0)-4.0,vec3(0.13,0.20,0.33));
  for(int i=0;i<9;i++) {
    float n=float(i), x=n*220.0-80.0;
    c=paint(c,segment(p,vec2(x,731.0-(x-800.0)*0.035+18.0),vec2(x-20.0,960.0))-7.0,ink);
  }
  // The small train drifts through the drawing with the song's clock.
  float travel=sin(uTime*0.06*uPaint.y)*36.0;
  for(int car=0;car<3;car++) {
    float x=599.0+float(car)*188.0+travel;
    vec2 q=vec2(p.x-x,p.y+(p.x-800.0)*0.035-682.0);
    float body=box(q,vec2(86,36))-4.0;
    vec3 bodyPaint=mix(vec3(0.64,0.73,0.69),vec3(0.21,0.38,0.43),step(8.0,q.y));
    c=outline(c,body,bodyPaint,ink);
    c=paint(c,box(q-vec2(0,-34),vec2(76,3)),vec3(0.40,0.53,0.57));
    c=paint(c,box(q-vec2(0,10),vec2(89,2)),vec3(0.82,0.55,0.39));
    c=paint(c,segment(q,vec2(-77,-33),vec2(77,-33))-0.7,vec3(0.78,0.81,0.69));
    for(int w=0;w<5;w++) {
      float wx=-65.0+float(w)*31.0;
      float win=box(q-vec2(wx,-9),vec2(10,13))-1.0;
      c=outline(c,win,vec3(0.95,0.79,0.47),vec3(0.26,0.39,0.47));
      c=paint(c,box(q-vec2(wx+5.0,-9),vec2(1,12)),vec3(0.66,0.61,0.43));
    }
    c=paint(c,length(q-vec2(-59,39))-6.0,ink);
    c=paint(c,length(q-vec2(59,39))-6.0,ink);
    c=paint(c,box(q-vec2(79,3),vec2(0.7,27)),vec3(0.34,0.48,0.51));
    c=paint(c,box(q-vec2(-79,3),vec2(0.7,27)),vec3(0.34,0.48,0.51));
    c=paint(c,box(q-vec2(75,5),vec2(1,1)),vec3(0.92,0.82,0.57));
  }
  float wire=477.0+0.000024*(p.x-700.0)*(p.x-700.0);
  c=paint(c,abs(p.y-wire)-0.9,vec3(0.17,0.25,0.39));
  c=paint(c,box(p-vec2(1365,645),vec2(3,210)),ink);
  c=paint(c,segment(p,vec2(1365,451),vec2(1295,451))-2.5,ink);
  c=paint(c,box(p-vec2(259,691),vec2(3,182)),ink);
  c=paint(c,segment(p,vec2(259,515),vec2(322,515))-2.2,ink);
  c=outline(c,901.0+ridge(p.x,0.8)*0.8-p.y,vec3(0.075,0.14,0.26),ink);
  frag=vec4(finishPaint(c,p),1.0);
}`;

  var FOREST = `
float canopy(vec2 q) {
  float d=ellipse(q,vec2(158,67));
  for(int i=0;i<12;i++) {
    float n=float(i),a=n*0.5236;
    vec2 at=vec2(cos(a)*159.0,sin(a)*60.0);
    float r=25.0+scatter(n+1.7)*20.0;
    d=min(d,ellipse(q-at,vec2(r,r*0.62)));
  }
  return d+sin(q.x*0.16+q.y*0.23)*1.1;
}
float bough(vec2 p,vec2 a,vec2 b,float radius) {
  vec2 v=b-a;
  float t=clamp(dot(p-a,v)/dot(v,v),0.0,1.0);
  return length(p-a-v*t)-mix(radius,radius*0.16,t);
}
vec3 tree(vec3 c,vec2 p,float x,float width,vec3 color) {
  float bend=x+sin(p.y*0.0036+x)*28.0;
  float trunk=max(abs(p.x-bend)-width*(0.48+p.y*0.0009),170.0-p.y);
  c=outline(c,trunk,color,mix(color,ink,0.5));
  c=paint(c,abs(p.x-bend+width*0.35)-width*0.09,mix(c,color*1.16,cover(trunk)));
  c=paint(c,bough(p,vec2(x,452),vec2(x-101.0,296),width*0.29),color);
  c=paint(c,bough(p,vec2(x-65.0,349),vec2(x-120.0,337),width*0.12),color);
  c=paint(c,bough(p,vec2(x,514),vec2(x+116.0,330),width*0.26),color);
  c=paint(c,bough(p,vec2(x+64.0,411),vec2(x+139.0,389),width*0.13),color);
  return c;
}
vec3 lantern(vec3 c,vec2 p,vec2 at,float size) {
  float sway=sin(uTime*0.34*uPaint.y+at.x)*3.0;
  at.x+=sway;
  vec2 q=(p-at)/size;
  c=paint(c,segment(p,vec2(at.x,at.y-155.0*size),vec2(at.x,at.y-25.0*size))-0.7,vec3(0.24,0.36,0.37));
  float lamp=max(abs(q.x)-(17.0-abs(q.y)*0.10),abs(q.y)-23.0);
  vec3 warm=mix(vec3(0.95,0.70,0.35),vec3(1.0,0.88,0.58),1.0-abs(q.x)/21.0);
  c=outline(c,lamp*size,warm,vec3(0.31,0.36,0.35));
  c=paint(c,box(q-vec2(0,-25),vec2(16,2.0))*size,vec3(0.32,0.37,0.33));
  c=paint(c,box(q-vec2(0,25),vec2(16,2.0))*size,vec3(0.34,0.37,0.32));
  for(int i=0;i<5;i++) {
    float y=-16.0+float(i)*8.0;
    c=mix(c,vec3(0.54,0.45,0.29),cover(box(q-vec2(0,y),vec2(15.0-abs(y)*0.08,0.45))*size)*0.60);
  }
  c=paint(c,segment(q,vec2(0,27),vec2(0,34))*size-0.8,vec3(0.73,0.58,0.32));
  return c;
}
void main() {
  vec2 p=drawing();
  vec3 c=mix(vec3(0.105,0.20,0.32),vec3(0.37,0.53,0.50),smoothstep(170.0,730.0,p.y));
  float clearing=ellipse(p-vec2(840,380),vec2(280,400));
  c=mix(c,vec3(0.58,0.65,0.54),exp(-max(clearing+210.0,0.0)*0.009)*0.12);
  float beam=abs(p.x+p.y*0.32-1044.0);
  c=mix(c,vec3(0.60,0.66,0.54),(1.0-smoothstep(52.0,68.0,beam))*0.07);
  // Blurred distant trunks, then increasingly crisp layers of foliage.
  for(int i=0;i<12;i++) {
    float n=float(i), x=n*144.0+40.0;
    float d=max(abs(p.x-x)-9.0,90.0-p.y);
    c=softPaint(c,d,4.5,vec3(0.24,0.40,0.43));
  }
  c=softPaint(c,624.0+ridge(p.x,3.5)-p.y,2.0,vec3(0.21,0.38,0.39));
  c=tree(c,p,383.0,20.0,vec3(0.16,0.30,0.34));
  c=tree(c,p,1234.0,24.0,vec3(0.17,0.31,0.35));
  c=outline(c,751.0+ridge(p.x,1.4)-p.y,vec3(0.105,0.26,0.30),ink);
  // A winding stream separates the foreground banks into flat painted shapes.
  float riverX=817.0+sin((p.y-625.0)*0.010)*54.0;
  float riverW=max(1.0,(p.y-630.0)*0.23);
  float river=max(abs(p.x-riverX)-riverW,640.0-p.y);
  c=outline(c,river,vec3(0.30,0.46,0.47),vec3(0.13,0.28,0.35));
  for(int i=0;i<18;i++) {
    float n=float(i), y=661.0+n*15.0, rx=817.0+sin((y-625.0)*0.01)*54.0;
    float line=box(p-vec2(rx+sin(n+uTime*0.18*uPaint.y)*9.0,y),vec2(3.0+n*1.65,0.8));
    c=mix(c,vec3(0.69,0.69,0.52),cover(line)*0.42);
  }
  // A quiet footbridge, outlined once with warm highlights along the rail.
  float bridgeY=759.0-19.0*cos((p.x-810.0)*0.009);
  float bridge=max(abs(p.y-bridgeY)-4.0,abs(p.x-810.0)-183.0);
  c=outline(c,bridge,vec3(0.38,0.34,0.31),ink);
  c=paint(c,max(abs(p.y-bridgeY+34.0)-1.4,abs(p.x-810.0)-182.0),vec3(0.69,0.57,0.39));
  for(int i=0;i<7;i++) {
    float x=637.0+float(i)*57.0,y=759.0-19.0*cos((x-810.0)*0.009);
    c=outline(c,box(p-vec2(x,y-16.0),vec2(1.8,21.0)),vec3(0.42,0.37,0.31),ink);
  }
  c=tree(c,p,202.0,49.0,vec3(0.095,0.22,0.27));
  c=tree(c,p,1415.0,62.0,vec3(0.095,0.21,0.27));
  for(int i=0;i<9;i++) {
    float n=float(i), x=n*229.0-100.0, y=38.0+sin(n*1.34)*37.0+abs(x-800.0)*0.17;
    vec2 q=(p-vec2(x,y))/1.02;
    float d=canopy(q);
    vec3 leaves=mix(vec3(0.14,0.32,0.34),vec3(0.105,0.25,0.29),step(4.0,q.y+18.0*sin(q.x*0.018)));
    c=outline(c,d,leaves,vec3(0.09,0.19,0.27));
    float speckle=vnoise(q*0.055)+vnoise(q*0.16)*0.5;
    c=mix(c,vec3(0.20,0.37,0.34),cover(d+7.0)*step(0.99,speckle)*0.33);
  }
  // Small pointed leaves at the canopy edge; no soft volumetric foliage.
  for(int i=0;i<24;i++) {
    float n=float(i), x=scatter(n*7.2)*1640.0-20.0, y=206.0+scatter(n*3.1)*88.0;
    vec2 q=p-vec2(x+sin(uTime*0.24*uPaint.y+n)*2.0,y);
    q=mat2(0.82,-0.57,0.57,0.82)*q;
    float leaf=max(length(q-vec2(0,11))-19.0,length(q+vec2(0,11))-19.0);
    c=outline(c,leaf,vec3(0.23,0.40,0.36),vec3(0.12,0.26,0.29));
    c=paint(c,max(abs(q.x)-0.5,abs(q.y)-12.0),mix(c,vec3(0.36,0.47,0.37),cover(leaf)));
  }
  c=lantern(c,p,vec2(452,427),0.86);
  c=lantern(c,p,vec2(1118,441),1.02);
  c=lantern(c,p,vec2(838,515),0.55);
  c=lantern(c,p,vec2(1350,324),0.72);
  for(int i=0;i<20;i++) {
    float n=float(i),x=384.0+scatter(n*4.0)*866.0,y=358.0+scatter(n*8.2)*393.0;
    vec2 at=vec2(x+sin(uTime*0.17*uPaint.y+n)*8.0,y+sin(uTime*0.23*uPaint.y+n*2.0)*6.0);
    float amount=(0.3+uPaint.z*0.6)*(0.7+sin(uTime*0.4*uPaint.y+n)*0.18);
    c=mix(c,vec3(0.94,0.84,0.53),cover(length(p-at)-1.5)*amount);
  }
  frag=vec4(finishPaint(c,p),1.0);
}`;

  // Navigation studies use the same composition and palette as the live art.
  // They contain no fonts or network resources and stay sharp in DBX as well.
  function study(id, top, bottom, shapes) {
    return '<svg class="ws-scene-art" viewBox="0 0 320 200" aria-hidden="true" focusable="false">'
      + '<defs><linearGradient id="' + id + '-sky" x2="0" y2="1"><stop stop-color="' + top
      + '"/><stop offset="1" stop-color="' + bottom + '"/></linearGradient></defs>'
      + '<rect width="320" height="200" fill="url(#' + id + '-sky)"/>' + shapes + '</svg>';
  }
  var cloudPath = 'M-42 11C-53 6-46-9-32-9C-34-29-10-40-1-24C8-58 48-43 45-17C62-30 85-9 77 5C106 4 108 24 81 24H-24C-47 24-55 18-42 11Z';
  function studyCloud(x,y,scale,light,shade) {
    return '<g transform="translate('+x+' '+y+') scale('+scale+')"><path d="'+cloudPath+'" fill="'+light+'" stroke="'+shade+'" stroke-width="1.2"/>'
      + '<path d="M-41 10Q-28 2-15 12Q-5-4 12 4Q24-15 33 2Q52-4 63 10Q73 1 84 10L84 19Q53 23-22 20Z" fill="'+shade+'"/></g>';
  }
  var artSky = study('cel-sky','#243e86','#8bc9db',
    '<circle cx="220" cy="47" r="9" fill="#f9f2d8"/>'
    + studyCloud(221,100,0.95,'#f9f4df','#9aafd5') + studyCloud(39,71,0.69,'#f0f0de','#95aacb')
    + '<path d="M0 151L27 137 55 141 85 126 121 139 143 132 181 145 210 130 263 142 291 135 320 147V200H0Z" fill="#628d9f"/>'
    + '<path d="M0 173Q42 140 87 158T176 164T248 153T320 169V200H0Z" fill="#365b6e" stroke="#344c68"/>'
    + '<path d="M0 185Q52 176 112 193T229 183T320 190V200H0Z" fill="#203f53"/>'
    + '<path d="M0 36Q183 38 320 69M0 40Q190 44 320 73M290 200V55m-8 4h25" fill="none" stroke="#334862" stroke-width="1.2"/>');
  var artCoast = study('cel-coast','#4a436e','#edaa7e',
    '<circle cx="207" cy="101" r="14" fill="#f8e4b5"/>'
    + studyCloud(36,81,0.75,'#ebc2a9','#a093b3') + studyCloud(258,49,0.52,'#e7bcaa','#998bad')
    + '<path d="M0 123H320V200H0Z" fill="#586782"/><path d="M0 123H320" stroke="#e5bc91"/>'
    + '<path d="M192 132h28m-39 9h42m-34 9h41m-48 10h63m-64 10h70m-79 12h84" stroke="#eac397" stroke-width="2"/>'
    + '<path d="M0 139L32 126 59 129 76 120 105 138Z" fill="#444d68"/>'
    + '<path d="M0 190Q45 153 102 177T228 184T320 194V200H0Z" fill="#303b54"/>'
    + '<path d="M20 200l8-29m5 29l13-35m-6 35l18-24M288 200v-48m26 48v-41m-38-4 44 10" stroke="#27354d" stroke-width="1.5" fill="none"/>');
  var trainWindows = '';
  for (var i=0;i<12;i++) trainWindows += '<rect x="'+(105+i*9)+'" y="143" width="5" height="7" rx=".6" fill="#f0cb83"/>';
  var artRail = study('cel-rail','#142048','#526d91',
    '<g fill="#dddcca"><circle cx="216" cy="44" r="10"/><circle cx="48" cy="30" r=".8"/><circle cx="111" cy="48" r="1"/><circle cx="174" cy="24" r=".7"/><circle cx="268" cy="78" r=".7"/></g>'
    + studyCloud(39,78,0.76,'#7486ae','#4b5d88')
    + '<path d="M0 126L24 115 57 124 92 106 144 125 183 119 239 104 291 120 320 113V200H0Z" fill="#394f74"/>'
    + '<path d="M0 137H320V200H0Z" fill="#2a4263"/><path d="M205 141h21m-28 7h29m-25 21h37m-46 9h57m-49 8h48" stroke="#92a8b2" opacity=".6"/>'
    + '<g transform="rotate(-2 160 160)"><path d="M0 164H320M33 168v34m95-34v34m112-34v34" stroke="#1f304c" stroke-width="3"/>'
    + '<rect x="100" y="138" width="112" height="22" rx="3" fill="#a0b8af" stroke="#24394e"/><path d="M101 154H211" stroke="#ac815f" stroke-width="3"/>' + trainWindows + '</g>'
    + '<path d="M0 105Q192 104 320 120M280 200V104m-15 0h15" fill="none" stroke="#213650" stroke-width="1.2"/>');
  var artForest = study('cel-forest','#244653','#638d81',
    '<path d="M29 0v184M77 0v151m50-151v174m111-174v163m53-163v190" stroke="#3b6566" stroke-width="6"/>'
    + '<path d="M0 160Q77 127 151 153T320 149V200H0Z" fill="#244b50"/>'
    + '<path d="M167 153Q127 171 169 188L151 200H187Q214 182 172 174Q152 166 178 155Z" fill="#7a9b92"/>'
    + '<path d="M34 200Q55 89 30 0m238 200Q249 80 280 0" fill="none" stroke="#1c4048" stroke-width="16"/>'
    + '<path d="M0 0H320V47Q301 56 281 45Q246 81 222 51Q200 67 180 48Q162 70 144 50Q95 89 74 48Q23 70 0 46Z" fill="#244d51" stroke="#203c48"/>'
    + '<path d="M94 47v40m129-37v51m-61-40v59" stroke="#324e4c"/>'
    + '<g fill="#f3ce85" stroke="#516353"><rect x="88" y="87" width="12" height="18" rx="3"/><rect x="216" y="101" width="14" height="21" rx="3"/><rect x="158" y="120" width="8" height="12" rx="2"/></g>'
    + '<path d="M120 170Q166 155 206 170m-86-6Q166 149 206 164m-83-1v10m26-16v11m26-12v11m26-5v10" stroke="#bcad7f" stroke-width="1.5" fill="none"/>'
    + '<g fill="#dfd292"><circle cx="139" cy="102" r="1"/><circle cx="195" cy="139" r="1.2"/><circle cx="119" cy="139" r=".8"/></g>');

  [
    { id: 'anime-sky', label: '晴空云海', aliases: ['晴空云海','晴空','云海','anime sky'],
      note: '风吹过云的留白，光落在远山。', tag: '01 / DAYLIGHT', art: artSky, shader: SKY,
      labels: ['日光亮度','云间微风','云影层次'] },
    { id: 'anime-coast', label: '黄昏海岸', aliases: ['黄昏海岸','黄昏','海岸','anime coast'],
      note: '暖橙色的余晖，藏进蓝紫潮汐。', tag: '02 / AFTERGLOW', art: artCoast, shader: COAST,
      labels: ['落日亮度','潮汐流速','海面碎光'] },
    { id: 'anime-rail', label: '月下列车', aliases: ['月下列车','月下','列车','anime rail'],
      note: '一列暖灯，驶过安静的靛蓝夜。', tag: '03 / MOONLIGHT', art: artRail, shader: RAIL,
      labels: ['月夜亮度','夜行节奏','星光层次'] },
    { id: 'anime-forest', label: '森间灯火', aliases: ['森间灯火','森林灯火','森间','anime forest'],
      note: '树影、溪流，和几盏温柔的灯。', tag: '04 / LANTERNS', art: artForest, shader: FOREST,
      labels: ['林间亮度','枝叶微风','萤火密度'] }
  ].forEach(function (scene) {
    CreativeGL.register({
      id: scene.id, label: scene.label, aliases: scene.aliases, ownsLyrics: false,
      params: [
        ['light',scene.labels[0],0.60,1.35,0.01,'',1.0],
        ['motion',scene.labels[1],0,2,0.05,'',0.65],
        ['detail',scene.labels[2],0,1,0.02,'',0.62]
      ],
      camera: { 'cam.yaw':0, 'cam.pitch':0, 'cam.dist':20, 'cam.fov':55, 'cam.height':0 },
      presentation: { family:'anime', description:scene.note, tag:scene.tag, art:scene.art },
      geom: { mode:'TRIANGLES', verts:6, instances:1 }, depth:false, blend:'surface',
      bloomScale:0.06, toneMapped:false,
      uniforms:['uPaint','uFrame'],
      decl:'uniform vec3 uPaint;\nuniform vec4 uFrame;\n',
      vert:VERT, frag:PAINT + scene.shader,
      setup:function (gl,U,S) {
        gl.uniform3f(U.uPaint,S.p.light,S.p.motion,S.p.detail);
        // Shared camera/model controls pan and crop the drawing without adding
        // perspective. Y rotation becomes a horizontal panorama adjustment.
        var m=S.modelMatrix, scale=m ? Math.max(0.01,Math.hypot(m[0],m[1],m[2])) : 1;
        // Direction components stay continuous across the +/-180 degree seam,
        // including when the host adds its small automatic camera drift.
        var turn=m ? m[8]/scale : 0;
        var zoom=Math.max(0.72,Math.min(1.22,(S.cam.dist+(S.cam.tz||0)*0.4)/20*S.cam.fov/55))/Math.sqrt(scale);
        gl.uniform4f(U.uFrame,(Math.sin(S.cam.yaw)-turn)*65+(S.cam.tx||0)*14,
          Math.sin(S.cam.pitch)*40-(S.cam.ty||0)*14,zoom,S.cam.roll||0);
      }
    });
  });
}());
