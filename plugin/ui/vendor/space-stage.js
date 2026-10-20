// SPDX-License-Identifier: MIT
// Generated from tools/space-stage; rebuild with npm run build. Three.js r186.
var SpaceStagePure=(()=>{var Ld=Object.defineProperty;var Cy=Object.getOwnPropertyDescriptor;var Ry=Object.getOwnPropertyNames;var Py=Object.prototype.hasOwnProperty;var S0=(i,e)=>{for(var t in e)Ld(i,t,{get:e[t],enumerable:!0})},Iy=(i,e,t,n)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of Ry(e))!Py.call(i,r)&&r!==t&&Ld(i,r,{get:()=>e[r],enumerable:!(n=Cy(e,r))||n.enumerable});return i};var Ly=i=>Iy(Ld({},"__esModule",{value:!0}),i);var O3={};S0(O3,{catalog:()=>I3,create:()=>B3,effectCatalog:()=>L3,normalizeQualityMode:()=>id,normalizeState:()=>F3,register:()=>D3,resolveId:()=>N3});var fi={};S0(fi,{ACESFilmicToneMapping:()=>rs,AddEquation:()=>is,AddOperation:()=>Jp,AdditiveAnimationBlendMode:()=>Yf,AdditiveBlending:()=>Cr,AgXToneMapping:()=>va,AlphaFormat:()=>Xf,AlwaysCompare:()=>fm,AlwaysDepth:()=>gl,AlwaysStencilFunc:()=>om,AmbientLight:()=>uc,AnimationAction:()=>_c,AnimationClip:()=>es,AnimationLoader:()=>qh,AnimationMixer:()=>of,AnimationObjectGroup:()=>sf,AnimationUtils:()=>Xh,ArcCurve:()=>Ul,ArrayCamera:()=>vc,ArrowHelper:()=>Rf,AttachedBindMode:()=>Th,Audio:()=>xc,AudioAnalyser:()=>rf,AudioContext:()=>ha,AudioListener:()=>tf,AudioLoader:()=>Qh,AxesHelper:()=>Pf,BackSide:()=>gn,BasicDepthPacking:()=>rm,BasicShadowMap:()=>Bg,BatchedMesh:()=>Pl,BezierInterpolant:()=>ac,Bone:()=>qo,BooleanKeyframeTrack:()=>Qi,Box2:()=>Mc,Box3:()=>cn,Box3Helper:()=>Ef,BoxGeometry:()=>In,BoxHelper:()=>Af,BufferAttribute:()=>ht,BufferGeometry:()=>et,BufferGeometryLoader:()=>mc,ByteType:()=>Gf,Cache:()=>Fi,Camera:()=>Hs,CameraHelper:()=>Tf,CanvasTexture:()=>Zo,CapsuleGeometry:()=>Nl,CatmullRomCurve3:()=>Us,CineonToneMapping:()=>ma,CircleGeometry:()=>Ds,ClampToEdgeWrapping:()=>zn,Clock:()=>df,Color:()=>be,ColorKeyframeTrack:()=>oa,ColorManagement:()=>vt,Compatibility:()=>Mv,CompressedArrayTexture:()=>Gh,CompressedCubeTexture:()=>Vh,CompressedTexture:()=>Ls,CompressedTextureLoader:()=>Yh,ConeGeometry:()=>Qn,ConstantAlphaFactor:()=>Yp,ConstantColorFactor:()=>Xp,Controls:()=>Lf,CubeCamera:()=>gc,CubeDepthTexture:()=>Dl,CubeReflectionMapping:()=>zi,CubeRefractionMapping:()=>Rr,CubeTexture:()=>Kr,CubeTextureLoader:()=>Zh,CubeUVReflectionMapping:()=>Zs,CubicBezierCurve:()=>Jo,CubicBezierCurve3:()=>Bl,CubicInterpolant:()=>sc,CullFaceBack:()=>Ff,CullFaceFront:()=>Rp,CullFaceFrontBack:()=>Ug,CullFaceNone:()=>Cp,Curve:()=>ei,CurvePath:()=>zl,CustomBlending:()=>Ip,CustomToneMapping:()=>ga,CylinderGeometry:()=>pn,Cylindrical:()=>mf,Data3DTexture:()=>Es,DataArrayTexture:()=>As,DataTexture:()=>Gn,DataTextureLoader:()=>$h,DataUtils:()=>Ph,DecrementStencilOp:()=>Qg,DecrementWrapStencilOp:()=>tv,DefaultLoadingManager:()=>vm,DepthFormat:()=>Ui,DepthStencilFormat:()=>Pr,DepthTexture:()=>Sr,DetachedBindMode:()=>Kp,DirectionalLight:()=>Ws,DirectionalLightHelper:()=>wf,DiscreteInterpolant:()=>oc,DodecahedronGeometry:()=>Ns,DoubleSide:()=>vn,DstAlphaFactor:()=>kp,DstColorFactor:()=>Vp,DynamicCopyUsage:()=>mv,DynamicDrawUsage:()=>lu,DynamicReadUsage:()=>fv,EdgesGeometry:()=>Fl,EllipseCurve:()=>Fs,EqualCompare:()=>cm,EqualDepth:()=>xl,EqualStencilFunc:()=>sv,EquirectangularReflectionMapping:()=>ya,EquirectangularRefractionMapping:()=>_a,Euler:()=>Vn,EventDispatcher:()=>jn,ExternalTexture:()=>$o,ExtrudeGeometry:()=>Hl,FileLoader:()=>Ai,Float16BufferAttribute:()=>Uh,Float32BufferAttribute:()=>Ve,FloatType:()=>Rn,Fog:()=>wl,FogExp2:()=>Ps,FramebufferTexture:()=>kh,FrontSide:()=>Er,Frustum:()=>Ki,FrustumArray:()=>Rl,GLBufferAttribute:()=>hf,GLSL1:()=>vv,GLSL3:()=>Zf,GreaterCompare:()=>um,GreaterDepth:()=>_l,GreaterEqualCompare:()=>au,GreaterEqualDepth:()=>yl,GreaterEqualStencilFunc:()=>cv,GreaterStencilFunc:()=>av,GridHelper:()=>Sf,Group:()=>kn,HTMLTexture:()=>Hh,HalfFloatType:()=>ln,HemisphereLight:()=>Gs,HemisphereLightHelper:()=>Mf,IcosahedronGeometry:()=>Os,ImageBitmapLoader:()=>jh,ImageLoader:()=>ts,ImageUtils:()=>bl,IncrementStencilOp:()=>jg,IncrementWrapStencilOp:()=>ev,InstancedBufferAttribute:()=>wi,InstancedBufferGeometry:()=>pc,InstancedInterleavedBuffer:()=>uf,InstancedMesh:()=>Ji,Int16BufferAttribute:()=>Nh,Int32BufferAttribute:()=>Fh,Int8BufferAttribute:()=>Ih,IntType:()=>bc,InterleavedBuffer:()=>Jr,InterleavedBufferAttribute:()=>_r,Interpolant:()=>Tr,InterpolateBezier:()=>Ah,InterpolateDiscrete:()=>Uo,InterpolateLinear:()=>Sl,InterpolateSmooth:()=>cl,InterpolationSamplingMode:()=>_v,InterpolationSamplingType:()=>yv,InvertStencilOp:()=>nv,KeepStencilOp:()=>ul,KeyframeTrack:()=>Wn,LOD:()=>Al,LatheGeometry:()=>Wl,Layers:()=>Cs,LessCompare:()=>lm,LessDepth:()=>vl,LessEqualCompare:()=>ou,LessEqualDepth:()=>ws,LessEqualStencilFunc:()=>ov,LessStencilFunc:()=>rv,Light:()=>Oi,LightProbe:()=>fc,LightShadow:()=>Vs,Line:()=>Bi,Line3:()=>vf,LineBasicMaterial:()=>dn,LineCurve:()=>Ko,LineCurve3:()=>Ol,LineDashedMaterial:()=>rc,LineLoop:()=>Il,LineSegments:()=>ci,LinearFilter:()=>zt,LinearInterpolant:()=>sa,LinearMipMapLinearFilter:()=>Vg,LinearMipMapNearestFilter:()=>Gg,LinearMipmapLinearFilter:()=>ki,LinearMipmapNearestFilter:()=>Ma,LinearSRGBColorSpace:()=>Oo,LinearToneMapping:()=>da,LinearTransfer:()=>zo,Loader:()=>_n,LoaderUtils:()=>ua,LoadingManager:()=>la,LoopOnce:()=>jp,LoopPingPong:()=>em,LoopRepeat:()=>Qp,MOUSE:()=>Ng,Material:()=>an,MaterialBlending:()=>Og,MaterialLoader:()=>dc,MathUtils:()=>$f,Matrix2:()=>gf,Matrix3:()=>ft,Matrix4:()=>it,MaxEquation:()=>Fp,Mesh:()=>at,MeshBasicMaterial:()=>Hn,MeshDepthMaterial:()=>ia,MeshDistanceMaterial:()=>ra,MeshLambertMaterial:()=>nc,MeshMatcapMaterial:()=>ic,MeshNormalMaterial:()=>tc,MeshPhongMaterial:()=>Ql,MeshPhysicalMaterial:()=>jl,MeshStandardMaterial:()=>Dt,MeshToonMaterial:()=>ec,MinEquation:()=>Np,MirroredRepeatWrapping:()=>Fo,MixOperation:()=>$p,MultiplyBlending:()=>Bf,MultiplyOperation:()=>fa,NearestFilter:()=>Kt,NearestMipMapLinearFilter:()=>kg,NearestMipMapNearestFilter:()=>zg,NearestMipmapLinearFilter:()=>$s,NearestMipmapNearestFilter:()=>kf,NeutralToneMapping:()=>xa,NeverCompare:()=>am,NeverDepth:()=>ml,NeverStencilFunc:()=>iv,NoBlending:()=>ui,NoColorSpace:()=>ir,NoNormalPacking:()=>Yg,NoToneMapping:()=>Mn,NormalAnimationBlendMode:()=>su,NormalBlending:()=>Ys,NormalGAPacking:()=>$g,NormalRGPacking:()=>Zg,NotEqualCompare:()=>hm,NotEqualDepth:()=>Ml,NotEqualStencilFunc:()=>lv,NumberKeyframeTrack:()=>zs,Object3D:()=>At,ObjectLoader:()=>Kh,ObjectSpaceNormalMap:()=>sm,OctahedronGeometry:()=>na,OneFactor:()=>Bp,OneMinusConstantAlphaFactor:()=>Zp,OneMinusConstantColorFactor:()=>qp,OneMinusDstAlphaFactor:()=>Gp,OneMinusDstColorFactor:()=>Hp,OneMinusSrcAlphaFactor:()=>zf,OneMinusSrcColorFactor:()=>zp,OrthographicCamera:()=>tr,PCFShadowMap:()=>ns,PCFSoftShadowMap:()=>Pp,PMREMGenerator:()=>to,Path:()=>jr,PerspectiveCamera:()=>Ft,Plane:()=>Mi,PlaneGeometry:()=>ji,PlaneHelper:()=>Cf,PointLight:()=>Ar,PointLightHelper:()=>_f,Points:()=>Is,PointsMaterial:()=>Yo,PolarGridHelper:()=>bf,PolyhedronGeometry:()=>br,PositionalAudio:()=>nf,PropertyBinding:()=>Rt,PropertyMixer:()=>yc,QuadraticBezierCurve:()=>jo,QuadraticBezierCurve3:()=>Qo,Quaternion:()=>Jt,QuaternionKeyframeTrack:()=>ks,QuaternionLinearInterpolant:()=>lc,R11_EAC_Format:()=>Uc,RED_GREEN_RGTC2_Format:()=>Ca,RED_RGTC1_Format:()=>nu,REVISION:()=>Ep,RG11_EAC_Format:()=>Ea,RGBADepthPacking:()=>Wg,RGBAFormat:()=>Pn,RGBAIntegerFormat:()=>Cc,RGBA_ASTC_10x10_Format:()=>Jc,RGBA_ASTC_10x5_Format:()=>Yc,RGBA_ASTC_10x6_Format:()=>Zc,RGBA_ASTC_10x8_Format:()=>$c,RGBA_ASTC_12x10_Format:()=>Kc,RGBA_ASTC_12x12_Format:()=>jc,RGBA_ASTC_4x4_Format:()=>zc,RGBA_ASTC_5x4_Format:()=>kc,RGBA_ASTC_5x5_Format:()=>Gc,RGBA_ASTC_6x5_Format:()=>Vc,RGBA_ASTC_6x6_Format:()=>Hc,RGBA_ASTC_8x5_Format:()=>Wc,RGBA_ASTC_8x6_Format:()=>Xc,RGBA_ASTC_8x8_Format:()=>qc,RGBA_BPTC_Format:()=>Qc,RGBA_ETC2_EAC_Format:()=>Fc,RGBA_PVRTC_2BPPV1_Format:()=>Lc,RGBA_PVRTC_4BPPV1_Format:()=>Ic,RGBA_S3TC_DXT1_Format:()=>wa,RGBA_S3TC_DXT3_Format:()=>Ta,RGBA_S3TC_DXT5_Format:()=>Aa,RGBDepthPacking:()=>Xg,RGBFormat:()=>qf,RGBIntegerFormat:()=>Hg,RGB_BPTC_SIGNED_Format:()=>eu,RGB_BPTC_UNSIGNED_Format:()=>tu,RGB_ETC1_Format:()=>Dc,RGB_ETC2_Format:()=>Nc,RGB_PVRTC_2BPPV1_Format:()=>Pc,RGB_PVRTC_4BPPV1_Format:()=>Rc,RGB_S3TC_DXT1_Format:()=>ba,RGDepthPacking:()=>qg,RGFormat:()=>Ir,RGIntegerFormat:()=>Ec,RawShaderMaterial:()=>Qr,Ray:()=>Mr,Raycaster:()=>ff,RectAreaLight:()=>hc,RedFormat:()=>Ac,RedIntegerFormat:()=>Sa,ReinhardToneMapping:()=>pa,RenderObjectRefreshType:()=>Sv,RenderTarget:()=>Vo,RenderTarget3D:()=>af,RepeatWrapping:()=>Yr,ReplaceStencilOp:()=>Kg,ReverseSubtractEquation:()=>Dp,RingGeometry:()=>Xl,SIGNED_R11_EAC_Format:()=>Bc,SIGNED_RED_GREEN_RGTC2_Format:()=>ru,SIGNED_RED_RGTC1_Format:()=>iu,SIGNED_RG11_EAC_Format:()=>Oc,SRGBColorSpace:()=>nn,SRGBTransfer:()=>bt,Scene:()=>li,ShaderChunk:()=>gt,ShaderLib:()=>Gi,ShaderMaterial:()=>Lt,ShadowMaterial:()=>Kl,Shape:()=>Ti,ShapeGeometry:()=>wr,ShapePath:()=>If,ShapeUtils:()=>bi,ShortType:()=>Vf,Skeleton:()=>Cl,SkeletonHelper:()=>yf,SkinnedMesh:()=>El,Source:()=>Eh,Sphere:()=>on,SphereGeometry:()=>mn,Spherical:()=>pf,SphericalHarmonics3:()=>ca,SplineCurve:()=>ea,SpotLight:()=>cc,SpotLightHelper:()=>xf,Sprite:()=>Tl,SpriteMaterial:()=>Xo,SrcAlphaFactor:()=>Of,SrcAlphaSaturateFactor:()=>Wp,SrcColorFactor:()=>Op,StaticCopyUsage:()=>pv,StaticDrawUsage:()=>js,StaticReadUsage:()=>hv,StereoCamera:()=>ef,StreamCopyUsage:()=>gv,StreamDrawUsage:()=>uv,StreamReadUsage:()=>dv,StringKeyframeTrack:()=>er,SubtractEquation:()=>Lp,SubtractiveBlending:()=>Uf,TOUCH:()=>Fg,TangentSpaceNormalMap:()=>nr,TetrahedronGeometry:()=>ql,Texture:()=>jt,TextureLoader:()=>Jh,TextureSource:()=>Si,TextureUtils:()=>Df,Timer:()=>Xs,TimestampQuery:()=>xv,TorusGeometry:()=>Yl,TorusKnotGeometry:()=>Zl,Triangle:()=>Ni,TriangleFanDrawMode:()=>im,TriangleStripDrawMode:()=>nm,TrianglesDrawMode:()=>tm,TubeGeometry:()=>$l,UVMapping:()=>Sc,Uint16BufferAttribute:()=>Ho,Uint32BufferAttribute:()=>Wo,Uint8BufferAttribute:()=>Lh,Uint8ClampedBufferAttribute:()=>Dh,Uniform:()=>lf,UniformsGroup:()=>cf,UniformsLib:()=>Xe,UniformsUtils:()=>rr,UnsignedByteType:()=>Xn,UnsignedInt101111Type:()=>Wf,UnsignedInt248Type:()=>Ks,UnsignedInt5999Type:()=>Hf,UnsignedIntType:()=>hi,UnsignedShort4444Type:()=>wc,UnsignedShort5551Type:()=>Tc,UnsignedShortType:()=>Js,VSMShadowMap:()=>qs,Vector2:()=>he,Vector3:()=>R,Vector4:()=>Pt,VectorKeyframeTrack:()=>aa,VideoFrameTexture:()=>zh,VideoTexture:()=>Ll,WebGL3DRenderTarget:()=>Rh,WebGLArrayRenderTarget:()=>Ch,WebGLCoordinateSystem:()=>Kn,WebGLCubeRenderTarget:()=>fu,WebGLRenderTarget:()=>Gt,WebGLRenderer:()=>Lr,WebGLUtils:()=>fx,WebGPUCoordinateSystem:()=>Zr,WebXRController:()=>Rs,WireframeGeometry:()=>Jl,WrapAroundEnding:()=>Bo,ZeroCurvatureEnding:()=>Xr,ZeroFactor:()=>Up,ZeroSlopeEnding:()=>qr,ZeroStencilOp:()=>Jg,createCanvasElement:()=>dm,error:()=>Qe,getConsoleFunction:()=>Tv,log:()=>Go,setConsoleFunction:()=>wv,warn:()=>Ge,warnOnce:()=>$i});var Ep="186",Ng={LEFT:0,MIDDLE:1,RIGHT:2,ROTATE:0,DOLLY:1,PAN:2},Fg={ROTATE:0,PAN:1,DOLLY_PAN:2,DOLLY_ROTATE:3},Cp=0,Ff=1,Rp=2,Ug=3,Bg=0,ns=1,Pp=2,qs=3,Er=0,gn=1,vn=2,ui=0,Ys=1,Cr=2,Uf=3,Bf=4,Ip=5,Og=6,is=100,Lp=101,Dp=102,Np=103,Fp=104,Up=200,Bp=201,Op=202,zp=203,Of=204,zf=205,kp=206,Gp=207,Vp=208,Hp=209,Wp=210,Xp=211,qp=212,Yp=213,Zp=214,ml=0,gl=1,vl=2,ws=3,xl=4,yl=5,_l=6,Ml=7,fa=0,$p=1,Jp=2,Mn=0,da=1,pa=2,ma=3,rs=4,ga=5,va=6,xa=7,Th="attached",Kp="detached",Sc=300,zi=301,Rr=302,ya=303,_a=304,Zs=306,Yr=1e3,zn=1001,Fo=1002,Kt=1003,kf=1004,zg=1004,$s=1005,kg=1005,zt=1006,Ma=1007,Gg=1007,ki=1008,Vg=1008,Xn=1009,Gf=1010,Vf=1011,Js=1012,bc=1013,hi=1014,Rn=1015,ln=1016,wc=1017,Tc=1018,Ks=1020,Hf=35902,Wf=35899,Xf=1021,qf=1022,Pn=1023,Ui=1026,Pr=1027,Ac=1028,Sa=1029,Ir=1030,Ec=1031,Hg=1032,Cc=1033,ba=33776,wa=33777,Ta=33778,Aa=33779,Rc=35840,Pc=35841,Ic=35842,Lc=35843,Dc=36196,Nc=37492,Fc=37496,Uc=37488,Bc=37489,Ea=37490,Oc=37491,zc=37808,kc=37809,Gc=37810,Vc=37811,Hc=37812,Wc=37813,Xc=37814,qc=37815,Yc=37816,Zc=37817,$c=37818,Jc=37819,Kc=37820,jc=37821,Qc=36492,eu=36494,tu=36495,nu=36283,iu=36284,Ca=36285,ru=36286,jp=2200,Qp=2201,em=2202,Uo=2300,Sl=2301,cl=2302,Ah=2303,Xr=2400,qr=2401,Bo=2402,su=2500,Yf=2501,tm=0,nm=1,im=2,rm=3200,Wg=3201,Xg=3202,qg=3203,nr=0,sm=1,ir="",nn="srgb",Oo="srgb-linear",zo="linear",bt="srgb",Yg="",Zg="rg",$g="ga",Jg=0,ul=7680,Kg=7681,jg=7682,Qg=7683,ev=34055,tv=34056,nv=5386,iv=512,rv=513,sv=514,ov=515,av=516,lv=517,cv=518,om=519,am=512,lm=513,cm=514,ou=515,um=516,hm=517,au=518,fm=519,js=35044,lu=35048,uv=35040,hv=35045,fv=35049,dv=35041,pv=35046,mv=35050,gv=35042,vv="100",Zf="300 es",Kn=2e3,Zr=2001,xv={COMPUTE:"compute",RENDER:"render"},yv={PERSPECTIVE:"perspective",LINEAR:"linear",FLAT:"flat"},_v={NORMAL:"normal",CENTROID:"centroid",SAMPLE:"sample",FIRST:"first",EITHER:"either"},Mv={TEXTURE_COMPARE:"depthTextureCompare"},Sv={NONE:0,SHARED:1,FULL:2};function Dy(i){for(let e=i.length-1;e>=0;--e)if(i[e]>=65535)return!0;return!1}var Ny={Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array};function Do(i,e){return new Ny[i](e)}function bv(i){return ArrayBuffer.isView(i)&&!(i instanceof DataView)}function ko(i){return document.createElementNS("http://www.w3.org/1999/xhtml",i)}function dm(){let i=ko("canvas");return i.style.display="block",i}var b0={},$r=null;function wv(i){$r=i}function Tv(){return $r}function Go(...i){let e="THREE."+i.shift();$r?$r("log",e,...i):console.log(e,...i)}function Av(i){let e=i[0];if(typeof e=="string"&&e.startsWith("TSL:")){let t=i[1];t&&t.isStackTrace?i[0]+=" "+t.getLocation():i[1]='Stack trace not available. Enable "THREE.Node.captureStackTrace" to capture stack traces.'}return i}function Ge(...i){i=Av(i);let e="THREE."+i.shift();if($r)$r("warn",e,...i);else{let t=i[0];t&&t.isStackTrace?console.warn(t.getError(e)):console.warn(e,...i)}}function Qe(...i){i=Av(i);let e="THREE."+i.shift();if($r)$r("error",e,...i);else{let t=i[0];t&&t.isStackTrace?console.error(t.getError(e)):console.error(e,...i)}}function $i(...i){let e=i.join(" ");e in b0||(b0[e]=!0,Ge(...i))}function Ev(i,e,t){return new Promise(function(n,r){function s(){switch(i.clientWaitSync(e,i.SYNC_FLUSH_COMMANDS_BIT,0)){case i.WAIT_FAILED:r();break;case i.TIMEOUT_EXPIRED:setTimeout(s,t);break;default:n()}}setTimeout(s,t)})}var Cv={[ml]:gl,[vl]:_l,[xl]:Ml,[ws]:yl,[gl]:ml,[_l]:vl,[Ml]:xl,[yl]:ws},jn=class{addEventListener(e,t){this._listeners===void 0&&(this._listeners={});let n=this._listeners;n[e]===void 0&&(n[e]=[]),n[e].indexOf(t)===-1&&n[e].push(t)}hasEventListener(e,t){let n=this._listeners;return n===void 0?!1:n[e]!==void 0&&n[e].indexOf(t)!==-1}removeEventListener(e,t){let n=this._listeners;if(n===void 0)return;let r=n[e];if(r!==void 0){let s=r.indexOf(t);s!==-1&&r.splice(s,1)}}dispatchEvent(e){let t=this._listeners;if(t===void 0)return;let n=t[e.type];if(n!==void 0){e.target=this;let r=n.slice(0);for(let s=0,o=r.length;s<o;s++)r[s].call(this,e);e.target=null}}},An=["00","01","02","03","04","05","06","07","08","09","0a","0b","0c","0d","0e","0f","10","11","12","13","14","15","16","17","18","19","1a","1b","1c","1d","1e","1f","20","21","22","23","24","25","26","27","28","29","2a","2b","2c","2d","2e","2f","30","31","32","33","34","35","36","37","38","39","3a","3b","3c","3d","3e","3f","40","41","42","43","44","45","46","47","48","49","4a","4b","4c","4d","4e","4f","50","51","52","53","54","55","56","57","58","59","5a","5b","5c","5d","5e","5f","60","61","62","63","64","65","66","67","68","69","6a","6b","6c","6d","6e","6f","70","71","72","73","74","75","76","77","78","79","7a","7b","7c","7d","7e","7f","80","81","82","83","84","85","86","87","88","89","8a","8b","8c","8d","8e","8f","90","91","92","93","94","95","96","97","98","99","9a","9b","9c","9d","9e","9f","a0","a1","a2","a3","a4","a5","a6","a7","a8","a9","aa","ab","ac","ad","ae","af","b0","b1","b2","b3","b4","b5","b6","b7","b8","b9","ba","bb","bc","bd","be","bf","c0","c1","c2","c3","c4","c5","c6","c7","c8","c9","ca","cb","cc","cd","ce","cf","d0","d1","d2","d3","d4","d5","d6","d7","d8","d9","da","db","dc","dd","de","df","e0","e1","e2","e3","e4","e5","e6","e7","e8","e9","ea","eb","ec","ed","ee","ef","f0","f1","f2","f3","f4","f5","f6","f7","f8","f9","fa","fb","fc","fd","fe","ff"],w0=1234567,bs=Math.PI/180,Ts=180/Math.PI;function ai(){let i=Math.random()*4294967295|0,e=Math.random()*4294967295|0,t=Math.random()*4294967295|0,n=Math.random()*4294967295|0;return(An[i&255]+An[i>>8&255]+An[i>>16&255]+An[i>>24&255]+"-"+An[e&255]+An[e>>8&255]+"-"+An[e>>16&15|64]+An[e>>24&255]+"-"+An[t&63|128]+An[t>>8&255]+"-"+An[t>>16&255]+An[t>>24&255]+An[n&255]+An[n>>8&255]+An[n>>16&255]+An[n>>24&255]).toLowerCase()}function ot(i,e,t){return Math.max(e,Math.min(t,i))}function pm(i,e){return(i%e+e)%e}function Fy(i,e,t,n,r){return n+(i-e)*(r-n)/(t-e)}function Uy(i,e,t){return i!==e?(t-i)/(e-i):0}function hl(i,e,t){return(1-t)*i+t*e}function By(i,e,t,n){return hl(i,e,1-Math.exp(-t*n))}function Oy(i,e=1){return e-Math.abs(pm(i,e*2)-e)}function zy(i,e,t){return i<=e?0:i>=t?1:(i=(i-e)/(t-e),i*i*(3-2*i))}function ky(i,e,t){return i<=e?0:i>=t?1:(i=(i-e)/(t-e),i*i*i*(i*(i*6-15)+10))}function Gy(i,e){return i+Math.floor(Math.random()*(e-i+1))}function Vy(i,e){return i+Math.random()*(e-i)}function Hy(i){return i*(.5-Math.random())}function Wy(i){i!==void 0&&(w0=i);let e=w0+=1831565813;return e=Math.imul(e^e>>>15,e|1),e^=e+Math.imul(e^e>>>7,e|61),((e^e>>>14)>>>0)/4294967296}function Xy(i){return i*bs}function qy(i){return i*Ts}function Yy(i){return i>0&&Number.isInteger(i)&&2**Math.round(Math.log2(i))===i}function Zy(i){return Math.pow(2,Math.ceil(Math.log(i)/Math.LN2))}function $y(i){return Math.pow(2,Math.floor(Math.log(i)/Math.LN2))}function Jy(i,e,t,n,r){let s=Math.cos,o=Math.sin,a=s(t/2),l=o(t/2),c=s((e+n)/2),u=o((e+n)/2),f=s((e-n)/2),h=o((e-n)/2),d=s((n-e)/2),p=o((n-e)/2);switch(r){case"XYX":i.set(a*u,l*f,l*h,a*c);break;case"YZY":i.set(l*h,a*u,l*f,a*c);break;case"ZXZ":i.set(l*f,l*h,a*u,a*c);break;case"XZX":i.set(a*u,l*p,l*d,a*c);break;case"YXY":i.set(l*d,a*u,l*p,a*c);break;case"ZYZ":i.set(l*p,l*d,a*u,a*c);break;default:Ge("MathUtils: .setQuaternionFromProperEuler() encountered an unknown order: "+r)}}function On(i,e){switch(e.constructor){case Float32Array:return i;case Uint32Array:return i/4294967295;case Uint16Array:return i/65535;case Uint8Array:case Uint8ClampedArray:return i/255;case Int32Array:return Math.max(i/2147483647,-1);case Int16Array:return Math.max(i/32767,-1);case Int8Array:return Math.max(i/127,-1);default:throw new Error("THREE.MathUtils: Invalid component type.")}}function mt(i,e){switch(e.constructor){case Float32Array:return i;case Uint32Array:return Math.round(i*4294967295);case Uint16Array:return Math.round(i*65535);case Uint8Array:case Uint8ClampedArray:return Math.round(i*255);case Int32Array:return Math.round(i*2147483647);case Int16Array:return Math.round(i*32767);case Int8Array:return Math.round(i*127);default:throw new Error("THREE.MathUtils: Invalid component type.")}}var $f={DEG2RAD:bs,RAD2DEG:Ts,generateUUID:ai,clamp:ot,euclideanModulo:pm,mapLinear:Fy,inverseLerp:Uy,lerp:hl,damp:By,pingpong:Oy,smoothstep:zy,smootherstep:ky,randInt:Gy,randFloat:Vy,randFloatSpread:Hy,seededRandom:Wy,degToRad:Xy,radToDeg:qy,isPowerOfTwo:Yy,ceilPowerOfTwo:Zy,floorPowerOfTwo:$y,setQuaternionFromProperEuler:Jy,normalize:mt,denormalize:On},_m=class _m{constructor(e=0,t=0){this.x=e,this.y=t}get width(){return this.x}set width(e){this.x=e}get height(){return this.y}set height(e){this.y=e}set(e,t){return this.x=e,this.y=t,this}setScalar(e){return this.x=e,this.y=e,this}setX(e){return this.x=e,this}setY(e){return this.y=e,this}setComponent(e,t){switch(e){case 0:this.x=t;break;case 1:this.y=t;break;default:throw new Error("THREE.Vector2: index is out of range: "+e)}return this}getComponent(e){switch(e){case 0:return this.x;case 1:return this.y;default:throw new Error("THREE.Vector2: index is out of range: "+e)}}clone(){return new this.constructor(this.x,this.y)}copy(e){return this.x=e.x,this.y=e.y,this}add(e){return this.x+=e.x,this.y+=e.y,this}addScalar(e){return this.x+=e,this.y+=e,this}addVectors(e,t){return this.x=e.x+t.x,this.y=e.y+t.y,this}addScaledVector(e,t){return this.x+=e.x*t,this.y+=e.y*t,this}sub(e){return this.x-=e.x,this.y-=e.y,this}subScalar(e){return this.x-=e,this.y-=e,this}subVectors(e,t){return this.x=e.x-t.x,this.y=e.y-t.y,this}multiply(e){return this.x*=e.x,this.y*=e.y,this}multiplyScalar(e){return this.x*=e,this.y*=e,this}divide(e){return this.x/=e.x,this.y/=e.y,this}divideScalar(e){return this.multiplyScalar(1/e)}applyMatrix3(e){let t=this.x,n=this.y,r=e.elements;return this.x=r[0]*t+r[3]*n+r[6],this.y=r[1]*t+r[4]*n+r[7],this}min(e){return this.x=Math.min(this.x,e.x),this.y=Math.min(this.y,e.y),this}max(e){return this.x=Math.max(this.x,e.x),this.y=Math.max(this.y,e.y),this}clamp(e,t){return this.x=ot(this.x,e.x,t.x),this.y=ot(this.y,e.y,t.y),this}clampScalar(e,t){return this.x=ot(this.x,e,t),this.y=ot(this.y,e,t),this}clampLength(e,t){let n=this.length();return this.divideScalar(n||1).multiplyScalar(ot(n,e,t))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this}negate(){return this.x=-this.x,this.y=-this.y,this}dot(e){return this.x*e.x+this.y*e.y}cross(e){return this.x*e.y-this.y*e.x}lengthSq(){return this.x*this.x+this.y*this.y}length(){return Math.sqrt(this.x*this.x+this.y*this.y)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)}normalize(){return this.divideScalar(this.length()||1)}angle(){return Math.atan2(-this.y,-this.x)+Math.PI}angleTo(e){let t=Math.sqrt(this.lengthSq()*e.lengthSq());if(t===0)return Math.PI/2;let n=this.dot(e)/t;return Math.acos(ot(n,-1,1))}distanceTo(e){return Math.sqrt(this.distanceToSquared(e))}distanceToSquared(e){let t=this.x-e.x,n=this.y-e.y;return t*t+n*n}manhattanDistanceTo(e){return Math.abs(this.x-e.x)+Math.abs(this.y-e.y)}setLength(e){return this.normalize().multiplyScalar(e)}lerp(e,t){return this.x+=(e.x-this.x)*t,this.y+=(e.y-this.y)*t,this}lerpVectors(e,t,n){return this.x=e.x+(t.x-e.x)*n,this.y=e.y+(t.y-e.y)*n,this}equals(e){return e.x===this.x&&e.y===this.y}fromArray(e,t=0){return this.x=e[t],this.y=e[t+1],this}toArray(e=[],t=0){return e[t]=this.x,e[t+1]=this.y,e}fromBufferAttribute(e,t){return this.x=e.getX(t),this.y=e.getY(t),this}rotateAround(e,t){let n=Math.cos(t),r=Math.sin(t),s=this.x-e.x,o=this.y-e.y;return this.x=s*n-o*r+e.x,this.y=s*r+o*n+e.y,this}random(){return this.x=Math.random(),this.y=Math.random(),this}*[Symbol.iterator](){yield this.x,yield this.y}};_m.prototype.isVector2=!0;var he=_m,Jt=class{constructor(e=0,t=0,n=0,r=1){this.isQuaternion=!0,this._x=e,this._y=t,this._z=n,this._w=r}static slerpFlat(e,t,n,r,s,o,a){let l=n[r+0],c=n[r+1],u=n[r+2],f=n[r+3],h=s[o+0],d=s[o+1],p=s[o+2],v=s[o+3];if(f!==v||l!==h||c!==d||u!==p){let g=l*h+c*d+u*p+f*v;g<0&&(h=-h,d=-d,p=-p,v=-v,g=-g);let m=1-a;if(g<.9995){let y=Math.acos(g),_=Math.sin(y);m=Math.sin(m*y)/_,a=Math.sin(a*y)/_,l=l*m+h*a,c=c*m+d*a,u=u*m+p*a,f=f*m+v*a}else{l=l*m+h*a,c=c*m+d*a,u=u*m+p*a,f=f*m+v*a;let y=1/Math.sqrt(l*l+c*c+u*u+f*f);l*=y,c*=y,u*=y,f*=y}}e[t]=l,e[t+1]=c,e[t+2]=u,e[t+3]=f}static multiplyQuaternionsFlat(e,t,n,r,s,o){let a=n[r],l=n[r+1],c=n[r+2],u=n[r+3],f=s[o],h=s[o+1],d=s[o+2],p=s[o+3];return e[t]=a*p+u*f+l*d-c*h,e[t+1]=l*p+u*h+c*f-a*d,e[t+2]=c*p+u*d+a*h-l*f,e[t+3]=u*p-a*f-l*h-c*d,e}get x(){return this._x}set x(e){this._x=e,this._onChangeCallback()}get y(){return this._y}set y(e){this._y=e,this._onChangeCallback()}get z(){return this._z}set z(e){this._z=e,this._onChangeCallback()}get w(){return this._w}set w(e){this._w=e,this._onChangeCallback()}set(e,t,n,r){return this._x=e,this._y=t,this._z=n,this._w=r,this._onChangeCallback(),this}clone(){return new this.constructor(this._x,this._y,this._z,this._w)}copy(e){return this._x=e.x,this._y=e.y,this._z=e.z,this._w=e.w,this._onChangeCallback(),this}setFromEuler(e,t=!0){let n=e._x,r=e._y,s=e._z,o=e._order,a=Math.cos,l=Math.sin,c=a(n/2),u=a(r/2),f=a(s/2),h=l(n/2),d=l(r/2),p=l(s/2);switch(o){case"XYZ":this._x=h*u*f+c*d*p,this._y=c*d*f-h*u*p,this._z=c*u*p+h*d*f,this._w=c*u*f-h*d*p;break;case"YXZ":this._x=h*u*f+c*d*p,this._y=c*d*f-h*u*p,this._z=c*u*p-h*d*f,this._w=c*u*f+h*d*p;break;case"ZXY":this._x=h*u*f-c*d*p,this._y=c*d*f+h*u*p,this._z=c*u*p+h*d*f,this._w=c*u*f-h*d*p;break;case"ZYX":this._x=h*u*f-c*d*p,this._y=c*d*f+h*u*p,this._z=c*u*p-h*d*f,this._w=c*u*f+h*d*p;break;case"YZX":this._x=h*u*f+c*d*p,this._y=c*d*f+h*u*p,this._z=c*u*p-h*d*f,this._w=c*u*f-h*d*p;break;case"XZY":this._x=h*u*f-c*d*p,this._y=c*d*f-h*u*p,this._z=c*u*p+h*d*f,this._w=c*u*f+h*d*p;break;default:Ge("Quaternion: .setFromEuler() encountered an unknown order: "+o)}return t===!0&&this._onChangeCallback(),this}setFromAxisAngle(e,t){let n=t/2,r=Math.sin(n);return this._x=e.x*r,this._y=e.y*r,this._z=e.z*r,this._w=Math.cos(n),this._onChangeCallback(),this}setFromRotationMatrix(e){let t=e.elements,n=t[0],r=t[4],s=t[8],o=t[1],a=t[5],l=t[9],c=t[2],u=t[6],f=t[10],h=n+a+f;if(h>0){let d=.5/Math.sqrt(h+1);this._w=.25/d,this._x=(u-l)*d,this._y=(s-c)*d,this._z=(o-r)*d}else if(n>a&&n>f){let d=2*Math.sqrt(1+n-a-f);this._w=(u-l)/d,this._x=.25*d,this._y=(r+o)/d,this._z=(s+c)/d}else if(a>f){let d=2*Math.sqrt(1+a-n-f);this._w=(s-c)/d,this._x=(r+o)/d,this._y=.25*d,this._z=(l+u)/d}else{let d=2*Math.sqrt(1+f-n-a);this._w=(o-r)/d,this._x=(s+c)/d,this._y=(l+u)/d,this._z=.25*d}return this._onChangeCallback(),this}setFromUnitVectors(e,t){let n=e.dot(t)+1;return n<1e-8?(n=0,Math.abs(e.x)>Math.abs(e.z)?(this._x=-e.y,this._y=e.x,this._z=0,this._w=n):(this._x=0,this._y=-e.z,this._z=e.y,this._w=n)):(this._x=e.y*t.z-e.z*t.y,this._y=e.z*t.x-e.x*t.z,this._z=e.x*t.y-e.y*t.x,this._w=n),this.normalize()}angleTo(e){return 2*Math.acos(Math.abs(ot(this.dot(e),-1,1)))}rotateTowards(e,t){let n=this.angleTo(e);if(n===0)return this;let r=Math.min(1,t/n);return this.slerp(e,r),this}identity(){return this.set(0,0,0,1)}invert(){return this.conjugate()}conjugate(){return this._x*=-1,this._y*=-1,this._z*=-1,this._onChangeCallback(),this}dot(e){return this._x*e._x+this._y*e._y+this._z*e._z+this._w*e._w}lengthSq(){return this._x*this._x+this._y*this._y+this._z*this._z+this._w*this._w}length(){return Math.sqrt(this._x*this._x+this._y*this._y+this._z*this._z+this._w*this._w)}normalize(){let e=this.length();return e===0?(this._x=0,this._y=0,this._z=0,this._w=1):(e=1/e,this._x=this._x*e,this._y=this._y*e,this._z=this._z*e,this._w=this._w*e),this._onChangeCallback(),this}multiply(e){return this.multiplyQuaternions(this,e)}premultiply(e){return this.multiplyQuaternions(e,this)}multiplyQuaternions(e,t){let n=e._x,r=e._y,s=e._z,o=e._w,a=t._x,l=t._y,c=t._z,u=t._w;return this._x=n*u+o*a+r*c-s*l,this._y=r*u+o*l+s*a-n*c,this._z=s*u+o*c+n*l-r*a,this._w=o*u-n*a-r*l-s*c,this._onChangeCallback(),this}slerp(e,t){let n=e._x,r=e._y,s=e._z,o=e._w,a=this.dot(e);a<0&&(n=-n,r=-r,s=-s,o=-o,a=-a);let l=1-t;if(a<.9995){let c=Math.acos(a),u=Math.sin(c);l=Math.sin(l*c)/u,t=Math.sin(t*c)/u,this._x=this._x*l+n*t,this._y=this._y*l+r*t,this._z=this._z*l+s*t,this._w=this._w*l+o*t,this._onChangeCallback()}else this._x=this._x*l+n*t,this._y=this._y*l+r*t,this._z=this._z*l+s*t,this._w=this._w*l+o*t,this.normalize();return this}slerpQuaternions(e,t,n){return this.copy(e).slerp(t,n)}random(){let e=2*Math.PI*Math.random(),t=2*Math.PI*Math.random(),n=Math.random(),r=Math.sqrt(1-n),s=Math.sqrt(n);return this.set(r*Math.sin(e),r*Math.cos(e),s*Math.sin(t),s*Math.cos(t))}equals(e){return e._x===this._x&&e._y===this._y&&e._z===this._z&&e._w===this._w}fromArray(e,t=0){return this._x=e[t],this._y=e[t+1],this._z=e[t+2],this._w=e[t+3],this._onChangeCallback(),this}toArray(e=[],t=0){return e[t]=this._x,e[t+1]=this._y,e[t+2]=this._z,e[t+3]=this._w,e}fromBufferAttribute(e,t){return this._x=e.getX(t),this._y=e.getY(t),this._z=e.getZ(t),this._w=e.getW(t),this._onChangeCallback(),this}toJSON(){return this.toArray()}_onChange(e){return this._onChangeCallback=e,this}_onChangeCallback(){}*[Symbol.iterator](){yield this._x,yield this._y,yield this._z,yield this._w}},Mm=class Mm{constructor(e=0,t=0,n=0){this.x=e,this.y=t,this.z=n}set(e,t,n){return n===void 0&&(n=this.z),this.x=e,this.y=t,this.z=n,this}setScalar(e){return this.x=e,this.y=e,this.z=e,this}setX(e){return this.x=e,this}setY(e){return this.y=e,this}setZ(e){return this.z=e,this}setComponent(e,t){switch(e){case 0:this.x=t;break;case 1:this.y=t;break;case 2:this.z=t;break;default:throw new Error("THREE.Vector3: index is out of range: "+e)}return this}getComponent(e){switch(e){case 0:return this.x;case 1:return this.y;case 2:return this.z;default:throw new Error("THREE.Vector3: index is out of range: "+e)}}clone(){return new this.constructor(this.x,this.y,this.z)}copy(e){return this.x=e.x,this.y=e.y,this.z=e.z,this}add(e){return this.x+=e.x,this.y+=e.y,this.z+=e.z,this}addScalar(e){return this.x+=e,this.y+=e,this.z+=e,this}addVectors(e,t){return this.x=e.x+t.x,this.y=e.y+t.y,this.z=e.z+t.z,this}addScaledVector(e,t){return this.x+=e.x*t,this.y+=e.y*t,this.z+=e.z*t,this}sub(e){return this.x-=e.x,this.y-=e.y,this.z-=e.z,this}subScalar(e){return this.x-=e,this.y-=e,this.z-=e,this}subVectors(e,t){return this.x=e.x-t.x,this.y=e.y-t.y,this.z=e.z-t.z,this}multiply(e){return this.x*=e.x,this.y*=e.y,this.z*=e.z,this}multiplyScalar(e){return this.x*=e,this.y*=e,this.z*=e,this}multiplyVectors(e,t){return this.x=e.x*t.x,this.y=e.y*t.y,this.z=e.z*t.z,this}applyEuler(e){return this.applyQuaternion(T0.setFromEuler(e))}applyAxisAngle(e,t){return this.applyQuaternion(T0.setFromAxisAngle(e,t))}applyMatrix3(e){let t=this.x,n=this.y,r=this.z,s=e.elements;return this.x=s[0]*t+s[3]*n+s[6]*r,this.y=s[1]*t+s[4]*n+s[7]*r,this.z=s[2]*t+s[5]*n+s[8]*r,this}applyNormalMatrix(e){return this.applyMatrix3(e).normalize()}applyMatrix4(e){let t=this.x,n=this.y,r=this.z,s=e.elements,o=1/(s[3]*t+s[7]*n+s[11]*r+s[15]);return this.x=(s[0]*t+s[4]*n+s[8]*r+s[12])*o,this.y=(s[1]*t+s[5]*n+s[9]*r+s[13])*o,this.z=(s[2]*t+s[6]*n+s[10]*r+s[14])*o,this}applyQuaternion(e){let t=this.x,n=this.y,r=this.z,s=e.x,o=e.y,a=e.z,l=e.w,c=2*(o*r-a*n),u=2*(a*t-s*r),f=2*(s*n-o*t);return this.x=t+l*c+o*f-a*u,this.y=n+l*u+a*c-s*f,this.z=r+l*f+s*u-o*c,this}project(e){return this.applyMatrix4(e.matrixWorldInverse).applyMatrix4(e.projectionMatrix)}unproject(e){return this.applyMatrix4(e.projectionMatrixInverse).applyMatrix4(e.matrixWorld)}transformDirection(e){let t=this.x,n=this.y,r=this.z,s=e.elements;return this.x=s[0]*t+s[4]*n+s[8]*r,this.y=s[1]*t+s[5]*n+s[9]*r,this.z=s[2]*t+s[6]*n+s[10]*r,this.normalize()}divide(e){return this.x/=e.x,this.y/=e.y,this.z/=e.z,this}divideScalar(e){return this.multiplyScalar(1/e)}min(e){return this.x=Math.min(this.x,e.x),this.y=Math.min(this.y,e.y),this.z=Math.min(this.z,e.z),this}max(e){return this.x=Math.max(this.x,e.x),this.y=Math.max(this.y,e.y),this.z=Math.max(this.z,e.z),this}clamp(e,t){return this.x=ot(this.x,e.x,t.x),this.y=ot(this.y,e.y,t.y),this.z=ot(this.z,e.z,t.z),this}clampScalar(e,t){return this.x=ot(this.x,e,t),this.y=ot(this.y,e,t),this.z=ot(this.z,e,t),this}clampLength(e,t){let n=this.length();return this.divideScalar(n||1).multiplyScalar(ot(n,e,t))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this.z=Math.floor(this.z),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this.z=Math.ceil(this.z),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this.z=Math.round(this.z),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this.z=Math.trunc(this.z),this}negate(){return this.x=-this.x,this.y=-this.y,this.z=-this.z,this}dot(e){return this.x*e.x+this.y*e.y+this.z*e.z}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z}length(){return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)+Math.abs(this.z)}normalize(){return this.divideScalar(this.length()||1)}setLength(e){return this.normalize().multiplyScalar(e)}lerp(e,t){return this.x+=(e.x-this.x)*t,this.y+=(e.y-this.y)*t,this.z+=(e.z-this.z)*t,this}lerpVectors(e,t,n){return this.x=e.x+(t.x-e.x)*n,this.y=e.y+(t.y-e.y)*n,this.z=e.z+(t.z-e.z)*n,this}cross(e){return this.crossVectors(this,e)}crossVectors(e,t){let n=e.x,r=e.y,s=e.z,o=t.x,a=t.y,l=t.z;return this.x=r*l-s*a,this.y=s*o-n*l,this.z=n*a-r*o,this}projectOnVector(e){let t=e.lengthSq();if(t===0)return this.set(0,0,0);let n=e.dot(this)/t;return this.copy(e).multiplyScalar(n)}projectOnPlane(e){return Dd.copy(this).projectOnVector(e),this.sub(Dd)}reflect(e){return this.sub(Dd.copy(e).multiplyScalar(2*this.dot(e)))}angleTo(e){let t=Math.sqrt(this.lengthSq()*e.lengthSq());if(t===0)return Math.PI/2;let n=this.dot(e)/t;return Math.acos(ot(n,-1,1))}distanceTo(e){return Math.sqrt(this.distanceToSquared(e))}distanceToSquared(e){let t=this.x-e.x,n=this.y-e.y,r=this.z-e.z;return t*t+n*n+r*r}manhattanDistanceTo(e){return Math.abs(this.x-e.x)+Math.abs(this.y-e.y)+Math.abs(this.z-e.z)}setFromSpherical(e){return this.setFromSphericalCoords(e.radius,e.phi,e.theta)}setFromSphericalCoords(e,t,n){let r=Math.sin(t)*e;return this.x=r*Math.sin(n),this.y=Math.cos(t)*e,this.z=r*Math.cos(n),this}setFromCylindrical(e){return this.setFromCylindricalCoords(e.radius,e.theta,e.y)}setFromCylindricalCoords(e,t,n){return this.x=e*Math.sin(t),this.y=n,this.z=e*Math.cos(t),this}setFromMatrixPosition(e){let t=e.elements;return this.x=t[12],this.y=t[13],this.z=t[14],this}setFromMatrixScale(e){let t=this.setFromMatrixColumn(e,0).length(),n=this.setFromMatrixColumn(e,1).length(),r=this.setFromMatrixColumn(e,2).length();return this.x=t,this.y=n,this.z=r,this}setFromMatrixColumn(e,t){return this.fromArray(e.elements,t*4)}setFromMatrix3Column(e,t){return this.fromArray(e.elements,t*3)}setFromEuler(e){return this.x=e._x,this.y=e._y,this.z=e._z,this}setFromColor(e){return this.x=e.r,this.y=e.g,this.z=e.b,this}equals(e){return e.x===this.x&&e.y===this.y&&e.z===this.z}fromArray(e,t=0){return this.x=e[t],this.y=e[t+1],this.z=e[t+2],this}toArray(e=[],t=0){return e[t]=this.x,e[t+1]=this.y,e[t+2]=this.z,e}fromBufferAttribute(e,t){return this.x=e.getX(t),this.y=e.getY(t),this.z=e.getZ(t),this}random(){return this.x=Math.random(),this.y=Math.random(),this.z=Math.random(),this}randomDirection(){let e=Math.random()*Math.PI*2,t=Math.random()*2-1,n=Math.sqrt(1-t*t);return this.x=n*Math.cos(e),this.y=t,this.z=n*Math.sin(e),this}*[Symbol.iterator](){yield this.x,yield this.y,yield this.z}};Mm.prototype.isVector3=!0;var R=Mm,Dd=new R,T0=new Jt,Sm=class Sm{constructor(e,t,n,r,s,o,a,l,c){this.elements=[1,0,0,0,1,0,0,0,1],e!==void 0&&this.set(e,t,n,r,s,o,a,l,c)}set(e,t,n,r,s,o,a,l,c){let u=this.elements;return u[0]=e,u[1]=r,u[2]=a,u[3]=t,u[4]=s,u[5]=l,u[6]=n,u[7]=o,u[8]=c,this}identity(){return this.set(1,0,0,0,1,0,0,0,1),this}copy(e){let t=this.elements,n=e.elements;return t[0]=n[0],t[1]=n[1],t[2]=n[2],t[3]=n[3],t[4]=n[4],t[5]=n[5],t[6]=n[6],t[7]=n[7],t[8]=n[8],this}extractBasis(e,t,n){return e.setFromMatrix3Column(this,0),t.setFromMatrix3Column(this,1),n.setFromMatrix3Column(this,2),this}setFromMatrix4(e){let t=e.elements;return this.set(t[0],t[4],t[8],t[1],t[5],t[9],t[2],t[6],t[10]),this}multiply(e){return this.multiplyMatrices(this,e)}premultiply(e){return this.multiplyMatrices(e,this)}multiplyMatrices(e,t){let n=e.elements,r=t.elements,s=this.elements,o=n[0],a=n[3],l=n[6],c=n[1],u=n[4],f=n[7],h=n[2],d=n[5],p=n[8],v=r[0],g=r[3],m=r[6],y=r[1],_=r[4],x=r[7],S=r[2],b=r[5],E=r[8];return s[0]=o*v+a*y+l*S,s[3]=o*g+a*_+l*b,s[6]=o*m+a*x+l*E,s[1]=c*v+u*y+f*S,s[4]=c*g+u*_+f*b,s[7]=c*m+u*x+f*E,s[2]=h*v+d*y+p*S,s[5]=h*g+d*_+p*b,s[8]=h*m+d*x+p*E,this}multiplyScalar(e){let t=this.elements;return t[0]*=e,t[3]*=e,t[6]*=e,t[1]*=e,t[4]*=e,t[7]*=e,t[2]*=e,t[5]*=e,t[8]*=e,this}determinant(){let e=this.elements,t=e[0],n=e[1],r=e[2],s=e[3],o=e[4],a=e[5],l=e[6],c=e[7],u=e[8];return t*o*u-t*a*c-n*s*u+n*a*l+r*s*c-r*o*l}invert(){let e=this.elements,t=e[0],n=e[1],r=e[2],s=e[3],o=e[4],a=e[5],l=e[6],c=e[7],u=e[8],f=u*o-a*c,h=a*l-u*s,d=c*s-o*l,p=t*f+n*h+r*d;if(p===0)return this.set(0,0,0,0,0,0,0,0,0);let v=1/p;return e[0]=f*v,e[1]=(r*c-u*n)*v,e[2]=(a*n-r*o)*v,e[3]=h*v,e[4]=(u*t-r*l)*v,e[5]=(r*s-a*t)*v,e[6]=d*v,e[7]=(n*l-c*t)*v,e[8]=(o*t-n*s)*v,this}transpose(){let e,t=this.elements;return e=t[1],t[1]=t[3],t[3]=e,e=t[2],t[2]=t[6],t[6]=e,e=t[5],t[5]=t[7],t[7]=e,this}getNormalMatrix(e){return this.setFromMatrix4(e).invert().transpose()}transposeIntoArray(e){let t=this.elements;return e[0]=t[0],e[1]=t[3],e[2]=t[6],e[3]=t[1],e[4]=t[4],e[5]=t[7],e[6]=t[2],e[7]=t[5],e[8]=t[8],this}setUvTransform(e,t,n,r,s,o,a){let l=Math.cos(s),c=Math.sin(s);return this.set(n*l,n*c,-n*(l*o+c*a)+o+e,-r*c,r*l,-r*(-c*o+l*a)+a+t,0,0,1),this}scale(e,t){return $i("Matrix3: .scale() is deprecated. Use .makeScale() instead."),this.premultiply(Nd.makeScale(e,t)),this}rotate(e){return $i("Matrix3: .rotate() is deprecated. Use .makeRotation() instead."),this.premultiply(Nd.makeRotation(-e)),this}translate(e,t){return $i("Matrix3: .translate() is deprecated. Use .makeTranslation() instead."),this.premultiply(Nd.makeTranslation(e,t)),this}makeTranslation(e,t){return e.isVector2?this.set(1,0,e.x,0,1,e.y,0,0,1):this.set(1,0,e,0,1,t,0,0,1),this}makeRotation(e){let t=Math.cos(e),n=Math.sin(e);return this.set(t,-n,0,n,t,0,0,0,1),this}makeScale(e,t){return this.set(e,0,0,0,t,0,0,0,1),this}equals(e){let t=this.elements,n=e.elements;for(let r=0;r<9;r++)if(t[r]!==n[r])return!1;return!0}fromArray(e,t=0){for(let n=0;n<9;n++)this.elements[n]=e[n+t];return this}toArray(e=[],t=0){let n=this.elements;return e[t]=n[0],e[t+1]=n[1],e[t+2]=n[2],e[t+3]=n[3],e[t+4]=n[4],e[t+5]=n[5],e[t+6]=n[6],e[t+7]=n[7],e[t+8]=n[8],e}clone(){return new this.constructor().fromArray(this.elements)}};Sm.prototype.isMatrix3=!0;var ft=Sm,Nd=new ft,A0=new ft().set(.4123908,.3575843,.1804808,.212639,.7151687,.0721923,.0193308,.1191948,.9505322),E0=new ft().set(3.2409699,-1.5373832,-.4986108,-.9692436,1.8759675,.0415551,.0556301,-.203977,1.0569715);function Ky(){let i={enabled:!0,workingColorSpace:Oo,spaces:{},convert:function(r,s,o){return this.enabled===!1||s===o||!s||!o||(this.spaces[s].transfer===bt&&(r.r=yr(r.r),r.g=yr(r.g),r.b=yr(r.b)),this.spaces[s].primaries!==this.spaces[o].primaries&&(r.applyMatrix3(this.spaces[s].toXYZ),r.applyMatrix3(this.spaces[o].fromXYZ)),this.spaces[o].transfer===bt&&(r.r=No(r.r),r.g=No(r.g),r.b=No(r.b))),r},workingToColorSpace:function(r,s){return this.convert(r,this.workingColorSpace,s)},colorSpaceToWorking:function(r,s){return this.convert(r,s,this.workingColorSpace)},getPrimaries:function(r){return this.spaces[r].primaries},getTransfer:function(r){return r===ir?zo:this.spaces[r].transfer},getToneMappingMode:function(r){return this.spaces[r].outputColorSpaceConfig.toneMappingMode||"standard"},getLuminanceCoefficients:function(r,s=this.workingColorSpace){return r.fromArray(this.spaces[s].luminanceCoefficients)},define:function(r){Object.assign(this.spaces,r)},_getMatrix:function(r,s,o){return r.copy(this.spaces[s].toXYZ).multiply(this.spaces[o].fromXYZ)},_getDrawingBufferColorSpace:function(r){return this.spaces[r].outputColorSpaceConfig.drawingBufferColorSpace},_getUnpackColorSpace:function(r=this.workingColorSpace){return this.spaces[r].workingColorSpaceConfig.unpackColorSpace},fromWorkingColorSpace:function(r,s){return $i("ColorManagement: .fromWorkingColorSpace() has been renamed to .workingToColorSpace()."),i.workingToColorSpace(r,s)},toWorkingColorSpace:function(r,s){return $i("ColorManagement: .toWorkingColorSpace() has been renamed to .colorSpaceToWorking()."),i.colorSpaceToWorking(r,s)}},e=[.64,.33,.3,.6,.15,.06],t=[.2126,.7152,.0722],n=[.3127,.329];return i.define({[Oo]:{primaries:e,whitePoint:n,transfer:zo,toXYZ:A0,fromXYZ:E0,luminanceCoefficients:t,workingColorSpaceConfig:{unpackColorSpace:nn},outputColorSpaceConfig:{drawingBufferColorSpace:nn}},[nn]:{primaries:e,whitePoint:n,transfer:bt,toXYZ:A0,fromXYZ:E0,luminanceCoefficients:t,outputColorSpaceConfig:{drawingBufferColorSpace:nn}}}),i}var vt=Ky();function yr(i){return i<.04045?i*.0773993808:Math.pow(i*.9478672986+.0521327014,2.4)}function No(i){return i<.0031308?i*12.92:1.055*Math.pow(i,.41666)-.055}var fo,bl=class{static getDataURL(e,t="image/png"){if(/^data:/i.test(e.src)||typeof HTMLCanvasElement>"u")return e.src;let n;if(e instanceof HTMLCanvasElement)n=e;else{fo===void 0&&(fo=ko("canvas")),fo.width=e.width,fo.height=e.height;let r=fo.getContext("2d");e instanceof ImageData?r.putImageData(e,0,0):r.drawImage(e,0,0,e.width,e.height),n=fo}return n.toDataURL(t)}static sRGBToLinear(e){if(typeof HTMLImageElement<"u"&&e instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&e instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&e instanceof ImageBitmap){let t=ko("canvas");t.width=e.width,t.height=e.height;let n=t.getContext("2d");n.drawImage(e,0,0,e.width,e.height);let r=n.getImageData(0,0,e.width,e.height),s=r.data;for(let o=0;o<s.length;o++)s[o]=yr(s[o]/255)*255;return n.putImageData(r,0,0),t}else if(e.data){let t=e.data.slice(0);for(let n=0;n<t.length;n++)t instanceof Uint8Array||t instanceof Uint8ClampedArray?t[n]=Math.floor(yr(t[n]/255)*255):t[n]=yr(t[n]);return{data:t,width:e.width,height:e.height}}else return Ge("ImageUtils.sRGBToLinear(): Unsupported image type. No color space conversion applied."),e}},jy=0,Si=class{constructor(e=null){this.isTextureSource=!0,Object.defineProperty(this,"id",{value:jy++}),this.uuid=ai(),this.data=e,this.dataReady=!0,this.version=0}getSize(e){let t=this.data;return typeof HTMLVideoElement<"u"&&t instanceof HTMLVideoElement?e.set(t.videoWidth,t.videoHeight,0):typeof VideoFrame<"u"&&t instanceof VideoFrame?e.set(t.displayWidth,t.displayHeight,0):t!==null?e.set(t.width,t.height,t.depth||0):e.set(0,0,0),e}set needsUpdate(e){e===!0&&this.version++}toJSON(e){let t=e===void 0||typeof e=="string";if(!t&&e.images[this.uuid]!==void 0)return e.images[this.uuid];let n={uuid:this.uuid,url:""},r=this.data;if(r!==null){let s;if(Array.isArray(r)){s=[];for(let o=0,a=r.length;o<a;o++)r[o].isDataTexture?s.push(Fd(r[o].image)):s.push(Fd(r[o]))}else s=Fd(r);n.url=s}return t||(e.images[this.uuid]=n),n}};function Fd(i){return typeof HTMLImageElement<"u"&&i instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&i instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&i instanceof ImageBitmap?bl.getDataURL(i):i.data?{data:Array.from(i.data),width:i.width,height:i.height,type:i.data.constructor.name}:(Ge("Texture: Unable to serialize Texture."),{})}var Eh=class extends Si{constructor(e=null){$i('Source: "Source" has been renamed to "TextureSource". Please update your code to use "THREE.TextureSource" instead.'),super(e),this.isSource=!0}},Qy=0,Ud=new R,jt=class i extends jn{constructor(e=i.DEFAULT_IMAGE,t=i.DEFAULT_MAPPING,n=zn,r=zn,s=zt,o=ki,a=Pn,l=Xn,c=i.DEFAULT_ANISOTROPY,u=ir){super(),this.isTexture=!0,Object.defineProperty(this,"id",{value:Qy++}),this.uuid=ai(),this.name="",this.source=new Si(e),this.mipmaps=[],this.mapping=t,this.channel=0,this.wrapS=n,this.wrapT=r,this.magFilter=s,this.minFilter=o,this.anisotropy=c,this.format=a,this.internalFormat=null,this.type=l,this.offset=new he(0,0),this.repeat=new he(1,1),this.center=new he(0,0),this.rotation=0,this.matrixAutoUpdate=!0,this.matrix=new ft,this.generateMipmaps=!0,this.premultiplyAlpha=!1,this.flipY=!0,this.unpackAlignment=4,this.colorSpace=u,this.userData={},this.updateRanges=[],this.version=0,this.onUpdate=null,this.renderTarget=null,this.isRenderTargetTexture=!1,this.isArrayTexture=!!(e&&e.depth&&e.depth>1),this.pmremVersion=0,this.normalized=!1}get width(){return this.source.getSize(Ud).x}get height(){return this.source.getSize(Ud).y}get depth(){return this.source.getSize(Ud).z}get image(){return this.source.data}set image(e){this.source.data=e}updateMatrix(){this.matrix.setUvTransform(this.offset.x,this.offset.y,this.repeat.x,this.repeat.y,this.rotation,this.center.x,this.center.y)}addUpdateRange(e,t){this.updateRanges.push({start:e,count:t})}clearUpdateRanges(){this.updateRanges.length=0}clone(){return new this.constructor().copy(this)}copy(e){return this.name=e.name,this.source=e.source,this.mipmaps=e.mipmaps.slice(0),this.mapping=e.mapping,this.channel=e.channel,this.wrapS=e.wrapS,this.wrapT=e.wrapT,this.magFilter=e.magFilter,this.minFilter=e.minFilter,this.anisotropy=e.anisotropy,this.format=e.format,this.internalFormat=e.internalFormat,this.type=e.type,this.normalized=e.normalized,this.offset.copy(e.offset),this.repeat.copy(e.repeat),this.center.copy(e.center),this.rotation=e.rotation,this.matrixAutoUpdate=e.matrixAutoUpdate,this.matrix.copy(e.matrix),this.generateMipmaps=e.generateMipmaps,this.premultiplyAlpha=e.premultiplyAlpha,this.flipY=e.flipY,this.unpackAlignment=e.unpackAlignment,this.colorSpace=e.colorSpace,this.renderTarget=e.renderTarget,this.isRenderTargetTexture=e.isRenderTargetTexture,this.isArrayTexture=e.isArrayTexture,this.userData=JSON.parse(JSON.stringify(e.userData)),this.needsUpdate=!0,this}setValues(e){for(let t in e){let n=e[t];if(n===void 0){Ge(`Texture.setValues(): parameter '${t}' has value of undefined.`);continue}let r=this[t];if(r===void 0){Ge(`Texture.setValues(): property '${t}' does not exist.`);continue}r&&n&&r.isVector2&&n.isVector2||r&&n&&r.isVector3&&n.isVector3||r&&n&&r.isMatrix3&&n.isMatrix3?r.copy(n):this[t]=n}}toJSON(e){let t=e===void 0||typeof e=="string";if(!t&&e.textures[this.uuid]!==void 0)return e.textures[this.uuid];let n={metadata:{version:4.7,type:"Texture",generator:"Texture.toJSON"},uuid:this.uuid,name:this.name,image:this.source.toJSON(e).uuid,mapping:this.mapping,channel:this.channel,repeat:[this.repeat.x,this.repeat.y],offset:[this.offset.x,this.offset.y],center:[this.center.x,this.center.y],rotation:this.rotation,wrap:[this.wrapS,this.wrapT],format:this.format,internalFormat:this.internalFormat,type:this.type,normalized:this.normalized,colorSpace:this.colorSpace,minFilter:this.minFilter,magFilter:this.magFilter,anisotropy:this.anisotropy,flipY:this.flipY,generateMipmaps:this.generateMipmaps,premultiplyAlpha:this.premultiplyAlpha,unpackAlignment:this.unpackAlignment};return Object.keys(this.userData).length>0&&(n.userData=this.userData),t||(e.textures[this.uuid]=n),n}dispose(){this.dispatchEvent({type:"dispose"})}transformUv(e){if(this.mapping!==Sc)return e;if(e.applyMatrix3(this.matrix),e.x<0||e.x>1)switch(this.wrapS){case Yr:e.x=e.x-Math.floor(e.x);break;case zn:e.x=e.x<0?0:1;break;case Fo:Math.abs(Math.floor(e.x)%2)===1?e.x=Math.ceil(e.x)-e.x:e.x=e.x-Math.floor(e.x);break}if(e.y<0||e.y>1)switch(this.wrapT){case Yr:e.y=e.y-Math.floor(e.y);break;case zn:e.y=e.y<0?0:1;break;case Fo:Math.abs(Math.floor(e.y)%2)===1?e.y=Math.ceil(e.y)-e.y:e.y=e.y-Math.floor(e.y);break}return this.flipY&&(e.y=1-e.y),e}set needsUpdate(e){e===!0&&(this.version++,this.source.needsUpdate=!0)}set needsPMREMUpdate(e){e===!0&&this.pmremVersion++}};jt.DEFAULT_IMAGE=null;jt.DEFAULT_MAPPING=Sc;jt.DEFAULT_ANISOTROPY=1;var bm=class bm{constructor(e=0,t=0,n=0,r=1){this.x=e,this.y=t,this.z=n,this.w=r}get width(){return this.z}set width(e){this.z=e}get height(){return this.w}set height(e){this.w=e}set(e,t,n,r){return this.x=e,this.y=t,this.z=n,this.w=r,this}setScalar(e){return this.x=e,this.y=e,this.z=e,this.w=e,this}setX(e){return this.x=e,this}setY(e){return this.y=e,this}setZ(e){return this.z=e,this}setW(e){return this.w=e,this}setComponent(e,t){switch(e){case 0:this.x=t;break;case 1:this.y=t;break;case 2:this.z=t;break;case 3:this.w=t;break;default:throw new Error("THREE.Vector4: index is out of range: "+e)}return this}getComponent(e){switch(e){case 0:return this.x;case 1:return this.y;case 2:return this.z;case 3:return this.w;default:throw new Error("THREE.Vector4: index is out of range: "+e)}}clone(){return new this.constructor(this.x,this.y,this.z,this.w)}copy(e){return this.x=e.x,this.y=e.y,this.z=e.z,this.w=e.w!==void 0?e.w:1,this}add(e){return this.x+=e.x,this.y+=e.y,this.z+=e.z,this.w+=e.w,this}addScalar(e){return this.x+=e,this.y+=e,this.z+=e,this.w+=e,this}addVectors(e,t){return this.x=e.x+t.x,this.y=e.y+t.y,this.z=e.z+t.z,this.w=e.w+t.w,this}addScaledVector(e,t){return this.x+=e.x*t,this.y+=e.y*t,this.z+=e.z*t,this.w+=e.w*t,this}sub(e){return this.x-=e.x,this.y-=e.y,this.z-=e.z,this.w-=e.w,this}subScalar(e){return this.x-=e,this.y-=e,this.z-=e,this.w-=e,this}subVectors(e,t){return this.x=e.x-t.x,this.y=e.y-t.y,this.z=e.z-t.z,this.w=e.w-t.w,this}multiply(e){return this.x*=e.x,this.y*=e.y,this.z*=e.z,this.w*=e.w,this}multiplyScalar(e){return this.x*=e,this.y*=e,this.z*=e,this.w*=e,this}applyMatrix4(e){let t=this.x,n=this.y,r=this.z,s=this.w,o=e.elements;return this.x=o[0]*t+o[4]*n+o[8]*r+o[12]*s,this.y=o[1]*t+o[5]*n+o[9]*r+o[13]*s,this.z=o[2]*t+o[6]*n+o[10]*r+o[14]*s,this.w=o[3]*t+o[7]*n+o[11]*r+o[15]*s,this}divide(e){return this.x/=e.x,this.y/=e.y,this.z/=e.z,this.w/=e.w,this}divideScalar(e){return this.multiplyScalar(1/e)}setAxisAngleFromQuaternion(e){this.w=2*Math.acos(e.w);let t=Math.sqrt(1-e.w*e.w);return t<1e-4?(this.x=1,this.y=0,this.z=0):(this.x=e.x/t,this.y=e.y/t,this.z=e.z/t),this}setAxisAngleFromRotationMatrix(e){let t,n,r,s,l=e.elements,c=l[0],u=l[4],f=l[8],h=l[1],d=l[5],p=l[9],v=l[2],g=l[6],m=l[10];if(Math.abs(u-h)<.01&&Math.abs(f-v)<.01&&Math.abs(p-g)<.01){if(Math.abs(u+h)<.1&&Math.abs(f+v)<.1&&Math.abs(p+g)<.1&&Math.abs(c+d+m-3)<.1)return this.set(1,0,0,0),this;t=Math.PI;let _=(c+1)/2,x=(d+1)/2,S=(m+1)/2,b=(u+h)/4,E=(f+v)/4,M=(p+g)/4;return _>x&&_>S?_<.01?(n=0,r=.707106781,s=.707106781):(n=Math.sqrt(_),r=b/n,s=E/n):x>S?x<.01?(n=.707106781,r=0,s=.707106781):(r=Math.sqrt(x),n=b/r,s=M/r):S<.01?(n=.707106781,r=.707106781,s=0):(s=Math.sqrt(S),n=E/s,r=M/s),this.set(n,r,s,t),this}let y=Math.sqrt((g-p)*(g-p)+(f-v)*(f-v)+(h-u)*(h-u));return Math.abs(y)<.001&&(y=1),this.x=(g-p)/y,this.y=(f-v)/y,this.z=(h-u)/y,this.w=Math.acos((c+d+m-1)/2),this}setFromMatrixPosition(e){let t=e.elements;return this.x=t[12],this.y=t[13],this.z=t[14],this.w=t[15],this}min(e){return this.x=Math.min(this.x,e.x),this.y=Math.min(this.y,e.y),this.z=Math.min(this.z,e.z),this.w=Math.min(this.w,e.w),this}max(e){return this.x=Math.max(this.x,e.x),this.y=Math.max(this.y,e.y),this.z=Math.max(this.z,e.z),this.w=Math.max(this.w,e.w),this}clamp(e,t){return this.x=ot(this.x,e.x,t.x),this.y=ot(this.y,e.y,t.y),this.z=ot(this.z,e.z,t.z),this.w=ot(this.w,e.w,t.w),this}clampScalar(e,t){return this.x=ot(this.x,e,t),this.y=ot(this.y,e,t),this.z=ot(this.z,e,t),this.w=ot(this.w,e,t),this}clampLength(e,t){let n=this.length();return this.divideScalar(n||1).multiplyScalar(ot(n,e,t))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this.z=Math.floor(this.z),this.w=Math.floor(this.w),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this.z=Math.ceil(this.z),this.w=Math.ceil(this.w),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this.z=Math.round(this.z),this.w=Math.round(this.w),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this.z=Math.trunc(this.z),this.w=Math.trunc(this.w),this}negate(){return this.x=-this.x,this.y=-this.y,this.z=-this.z,this.w=-this.w,this}dot(e){return this.x*e.x+this.y*e.y+this.z*e.z+this.w*e.w}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w}length(){return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)+Math.abs(this.z)+Math.abs(this.w)}normalize(){return this.divideScalar(this.length()||1)}setLength(e){return this.normalize().multiplyScalar(e)}lerp(e,t){return this.x+=(e.x-this.x)*t,this.y+=(e.y-this.y)*t,this.z+=(e.z-this.z)*t,this.w+=(e.w-this.w)*t,this}lerpVectors(e,t,n){return this.x=e.x+(t.x-e.x)*n,this.y=e.y+(t.y-e.y)*n,this.z=e.z+(t.z-e.z)*n,this.w=e.w+(t.w-e.w)*n,this}equals(e){return e.x===this.x&&e.y===this.y&&e.z===this.z&&e.w===this.w}fromArray(e,t=0){return this.x=e[t],this.y=e[t+1],this.z=e[t+2],this.w=e[t+3],this}toArray(e=[],t=0){return e[t]=this.x,e[t+1]=this.y,e[t+2]=this.z,e[t+3]=this.w,e}fromBufferAttribute(e,t){return this.x=e.getX(t),this.y=e.getY(t),this.z=e.getZ(t),this.w=e.getW(t),this}random(){return this.x=Math.random(),this.y=Math.random(),this.z=Math.random(),this.w=Math.random(),this}*[Symbol.iterator](){yield this.x,yield this.y,yield this.z,yield this.w}};bm.prototype.isVector4=!0;var Pt=bm,Vo=class extends jn{constructor(e=1,t=1,n={}){super(),n=Object.assign({generateMipmaps:!1,internalFormat:null,minFilter:zt,depthBuffer:!0,stencilBuffer:!1,resolveColorBuffer:!0,resolveDepthBuffer:!0,resolveStencilBuffer:!0,storeMultisampledColorBuffer:!0,storeMultisampledDepthBuffer:!0,storeMultisampledStencilBuffer:!0,depthTexture:null,samples:0,count:1,depth:1,multiview:!1,useArrayDepthTexture:!1},n),this.isRenderTarget=!0,this.width=e,this.height=t,this.depth=n.depth,this.scissor=new Pt(0,0,e,t),this.scissorTest=!1,this.viewport=new Pt(0,0,e,t),this.textures=[];let r={width:e,height:t,depth:n.depth},s=new jt(r),o=n.count;for(let a=0;a<o;a++)this.textures[a]=s.clone(),this.textures[a].isRenderTargetTexture=!0,this.textures[a].renderTarget=this;this._setTextureOptions(n),this.depthBuffer=n.depthBuffer,this.stencilBuffer=n.stencilBuffer,this.resolveColorBuffer=n.resolveColorBuffer,this.resolveDepthBuffer=n.resolveDepthBuffer,this.resolveStencilBuffer=n.resolveStencilBuffer,this.storeMultisampledColorBuffer=n.storeMultisampledColorBuffer,this.storeMultisampledDepthBuffer=n.storeMultisampledDepthBuffer,this.storeMultisampledStencilBuffer=n.storeMultisampledStencilBuffer,this._depthTexture=null,this.depthTexture=n.depthTexture,this.samples=n.samples,this.multiview=n.multiview,this.useArrayDepthTexture=n.useArrayDepthTexture}_setTextureOptions(e={}){let t={minFilter:zt,generateMipmaps:!1,flipY:!1,internalFormat:null};e.mapping!==void 0&&(t.mapping=e.mapping),e.wrapS!==void 0&&(t.wrapS=e.wrapS),e.wrapT!==void 0&&(t.wrapT=e.wrapT),e.wrapR!==void 0&&(t.wrapR=e.wrapR),e.magFilter!==void 0&&(t.magFilter=e.magFilter),e.minFilter!==void 0&&(t.minFilter=e.minFilter),e.format!==void 0&&(t.format=e.format),e.type!==void 0&&(t.type=e.type),e.anisotropy!==void 0&&(t.anisotropy=e.anisotropy),e.colorSpace!==void 0&&(t.colorSpace=e.colorSpace),e.flipY!==void 0&&(t.flipY=e.flipY),e.generateMipmaps!==void 0&&(t.generateMipmaps=e.generateMipmaps),e.internalFormat!==void 0&&(t.internalFormat=e.internalFormat);for(let n=0;n<this.textures.length;n++)this.textures[n].setValues(t)}get texture(){return this.textures[0]}set texture(e){this.textures[0]=e}set depthTexture(e){this._depthTexture!==null&&this._depthTexture.renderTarget===this&&(this._depthTexture.renderTarget=null),e!==null&&e.renderTarget===null&&(e.renderTarget=this),this._depthTexture=e}get depthTexture(){return this._depthTexture}setSize(e,t,n=1){if(this.width!==e||this.height!==t||this.depth!==n){this.width=e,this.height=t,this.depth=n;for(let r=0,s=this.textures.length;r<s;r++)this.textures[r].image.width=e,this.textures[r].image.height=t,this.textures[r].image.depth=n,this.textures[r].isData3DTexture!==!0&&(this.textures[r].isArrayTexture=this.textures[r].image.depth>1);this.dispose()}this.viewport.set(0,0,e,t),this.scissor.set(0,0,e,t)}clone(){return new this.constructor().copy(this)}copy(e){this.width=e.width,this.height=e.height,this.depth=e.depth,this.scissor.copy(e.scissor),this.scissorTest=e.scissorTest,this.viewport.copy(e.viewport),this.textures.length=0;for(let t=0,n=e.textures.length;t<n;t++){this.textures[t]=e.textures[t].clone(),this.textures[t].isRenderTargetTexture=!0,this.textures[t].renderTarget=this;let r=Object.assign({},e.textures[t].image);this.textures[t].source=new Si(r)}if(this.depthBuffer=e.depthBuffer,this.stencilBuffer=e.stencilBuffer,this.resolveColorBuffer=e.resolveColorBuffer,this.resolveDepthBuffer=e.resolveDepthBuffer,this.resolveStencilBuffer=e.resolveStencilBuffer,this.storeMultisampledColorBuffer=e.storeMultisampledColorBuffer,this.storeMultisampledDepthBuffer=e.storeMultisampledDepthBuffer,this.storeMultisampledStencilBuffer=e.storeMultisampledStencilBuffer,e.depthTexture!==null)if(e.depthTexture.renderTarget===e){let t=e.depthTexture.clone();t.renderTarget=null,this.depthTexture=t}else this.depthTexture=e.depthTexture;return this.samples=e.samples,this.multiview=e.multiview,this.useArrayDepthTexture=e.useArrayDepthTexture,this}dispose(){this.dispatchEvent({type:"dispose"})}},Gt=class extends Vo{constructor(e=1,t=1,n={}){super(e,t,n),this.isWebGLRenderTarget=!0}},As=class extends jt{constructor(e=null,t=1,n=1,r=1){super(null),this.isDataArrayTexture=!0,this.image={data:e,width:t,height:n,depth:r},this.magFilter=Kt,this.minFilter=Kt,this.wrapR=zn,this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1,this.layerUpdates=new Set}copy(e){return super.copy(e),this.wrapR=e.wrapR,this}addLayerUpdate(e){this.layerUpdates.add(e)}clearLayerUpdates(){this.layerUpdates.clear()}},Ch=class extends Gt{constructor(e=1,t=1,n=1,r={}){super(e,t,r),this.isWebGLArrayRenderTarget=!0,this.depth=n,this.texture=new As(null,e,t,n),this._setTextureOptions(r),this.texture.isRenderTargetTexture=!0}},Es=class extends jt{constructor(e=null,t=1,n=1,r=1){super(null),this.isData3DTexture=!0,this.image={data:e,width:t,height:n,depth:r},this.magFilter=Kt,this.minFilter=Kt,this.wrapR=zn,this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}copy(e){return super.copy(e),this.wrapR=e.wrapR,this}},Rh=class extends Gt{constructor(e=1,t=1,n=1,r={}){super(e,t,r),this.isWebGL3DRenderTarget=!0,this.depth=n,this.texture=new Es(null,e,t,n),this._setTextureOptions(r),this.texture.isRenderTargetTexture=!0}},Nf=class Nf{constructor(e,t,n,r,s,o,a,l,c,u,f,h,d,p,v,g){this.elements=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],e!==void 0&&this.set(e,t,n,r,s,o,a,l,c,u,f,h,d,p,v,g)}set(e,t,n,r,s,o,a,l,c,u,f,h,d,p,v,g){let m=this.elements;return m[0]=e,m[4]=t,m[8]=n,m[12]=r,m[1]=s,m[5]=o,m[9]=a,m[13]=l,m[2]=c,m[6]=u,m[10]=f,m[14]=h,m[3]=d,m[7]=p,m[11]=v,m[15]=g,this}identity(){return this.set(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1),this}clone(){return new Nf().fromArray(this.elements)}copy(e){let t=this.elements,n=e.elements;return t[0]=n[0],t[1]=n[1],t[2]=n[2],t[3]=n[3],t[4]=n[4],t[5]=n[5],t[6]=n[6],t[7]=n[7],t[8]=n[8],t[9]=n[9],t[10]=n[10],t[11]=n[11],t[12]=n[12],t[13]=n[13],t[14]=n[14],t[15]=n[15],this}copyPosition(e){let t=this.elements,n=e.elements;return t[12]=n[12],t[13]=n[13],t[14]=n[14],this}setFromMatrix3(e){let t=e.elements;return this.set(t[0],t[3],t[6],0,t[1],t[4],t[7],0,t[2],t[5],t[8],0,0,0,0,1),this}extractBasis(e,t,n){return this.determinantAffine()===0?(e.set(1,0,0),t.set(0,1,0),n.set(0,0,1),this):(e.setFromMatrixColumn(this,0),t.setFromMatrixColumn(this,1),n.setFromMatrixColumn(this,2),this)}makeBasis(e,t,n){return this.set(e.x,t.x,n.x,0,e.y,t.y,n.y,0,e.z,t.z,n.z,0,0,0,0,1),this}extractRotation(e){if(e.determinantAffine()===0)return this.identity();let t=this.elements,n=e.elements,r=1/po.setFromMatrixColumn(e,0).length(),s=1/po.setFromMatrixColumn(e,1).length(),o=1/po.setFromMatrixColumn(e,2).length();return t[0]=n[0]*r,t[1]=n[1]*r,t[2]=n[2]*r,t[3]=0,t[4]=n[4]*s,t[5]=n[5]*s,t[6]=n[6]*s,t[7]=0,t[8]=n[8]*o,t[9]=n[9]*o,t[10]=n[10]*o,t[11]=0,t[12]=0,t[13]=0,t[14]=0,t[15]=1,this}makeRotationFromEuler(e){let t=this.elements,n=e.x,r=e.y,s=e.z,o=Math.cos(n),a=Math.sin(n),l=Math.cos(r),c=Math.sin(r),u=Math.cos(s),f=Math.sin(s);if(e.order==="XYZ"){let h=o*u,d=o*f,p=a*u,v=a*f;t[0]=l*u,t[4]=-l*f,t[8]=c,t[1]=d+p*c,t[5]=h-v*c,t[9]=-a*l,t[2]=v-h*c,t[6]=p+d*c,t[10]=o*l}else if(e.order==="YXZ"){let h=l*u,d=l*f,p=c*u,v=c*f;t[0]=h+v*a,t[4]=p*a-d,t[8]=o*c,t[1]=o*f,t[5]=o*u,t[9]=-a,t[2]=d*a-p,t[6]=v+h*a,t[10]=o*l}else if(e.order==="ZXY"){let h=l*u,d=l*f,p=c*u,v=c*f;t[0]=h-v*a,t[4]=-o*f,t[8]=p+d*a,t[1]=d+p*a,t[5]=o*u,t[9]=v-h*a,t[2]=-o*c,t[6]=a,t[10]=o*l}else if(e.order==="ZYX"){let h=o*u,d=o*f,p=a*u,v=a*f;t[0]=l*u,t[4]=p*c-d,t[8]=h*c+v,t[1]=l*f,t[5]=v*c+h,t[9]=d*c-p,t[2]=-c,t[6]=a*l,t[10]=o*l}else if(e.order==="YZX"){let h=o*l,d=o*c,p=a*l,v=a*c;t[0]=l*u,t[4]=v-h*f,t[8]=p*f+d,t[1]=f,t[5]=o*u,t[9]=-a*u,t[2]=-c*u,t[6]=d*f+p,t[10]=h-v*f}else if(e.order==="XZY"){let h=o*l,d=o*c,p=a*l,v=a*c;t[0]=l*u,t[4]=-f,t[8]=c*u,t[1]=h*f+v,t[5]=o*u,t[9]=d*f-p,t[2]=p*f-d,t[6]=a*u,t[10]=v*f+h}return t[3]=0,t[7]=0,t[11]=0,t[12]=0,t[13]=0,t[14]=0,t[15]=1,this}makeRotationFromQuaternion(e){return this.compose(e_,e,t_)}lookAt(e,t,n){let r=this.elements;return si.subVectors(e,t),si.lengthSq()===0&&(si.z=1),si.normalize(),zr.crossVectors(n,si),zr.lengthSq()===0&&(Math.abs(n.z)===1?si.x+=1e-4:si.z+=1e-4,si.normalize(),zr.crossVectors(n,si)),zr.normalize(),Uu.crossVectors(si,zr),r[0]=zr.x,r[4]=Uu.x,r[8]=si.x,r[1]=zr.y,r[5]=Uu.y,r[9]=si.y,r[2]=zr.z,r[6]=Uu.z,r[10]=si.z,this}multiply(e){return this.multiplyMatrices(this,e)}premultiply(e){return this.multiplyMatrices(e,this)}multiplyMatrices(e,t){let n=e.elements,r=t.elements,s=this.elements,o=n[0],a=n[4],l=n[8],c=n[12],u=n[1],f=n[5],h=n[9],d=n[13],p=n[2],v=n[6],g=n[10],m=n[14],y=n[3],_=n[7],x=n[11],S=n[15],b=r[0],E=r[4],M=r[8],T=r[12],A=r[1],I=r[5],D=r[9],B=r[13],F=r[2],L=r[6],U=r[10],X=r[14],te=r[3],Z=r[7],K=r[11],j=r[15];return s[0]=o*b+a*A+l*F+c*te,s[4]=o*E+a*I+l*L+c*Z,s[8]=o*M+a*D+l*U+c*K,s[12]=o*T+a*B+l*X+c*j,s[1]=u*b+f*A+h*F+d*te,s[5]=u*E+f*I+h*L+d*Z,s[9]=u*M+f*D+h*U+d*K,s[13]=u*T+f*B+h*X+d*j,s[2]=p*b+v*A+g*F+m*te,s[6]=p*E+v*I+g*L+m*Z,s[10]=p*M+v*D+g*U+m*K,s[14]=p*T+v*B+g*X+m*j,s[3]=y*b+_*A+x*F+S*te,s[7]=y*E+_*I+x*L+S*Z,s[11]=y*M+_*D+x*U+S*K,s[15]=y*T+_*B+x*X+S*j,this}multiplyScalar(e){let t=this.elements;return t[0]*=e,t[4]*=e,t[8]*=e,t[12]*=e,t[1]*=e,t[5]*=e,t[9]*=e,t[13]*=e,t[2]*=e,t[6]*=e,t[10]*=e,t[14]*=e,t[3]*=e,t[7]*=e,t[11]*=e,t[15]*=e,this}determinant(){let e=this.elements,t=e[0],n=e[4],r=e[8],s=e[12],o=e[1],a=e[5],l=e[9],c=e[13],u=e[2],f=e[6],h=e[10],d=e[14],p=e[3],v=e[7],g=e[11],m=e[15],y=l*d-c*h,_=a*d-c*f,x=a*h-l*f,S=o*d-c*u,b=o*h-l*u,E=o*f-a*u;return t*(v*y-g*_+m*x)-n*(p*y-g*S+m*b)+r*(p*_-v*S+m*E)-s*(p*x-v*b+g*E)}determinantAffine(){let e=this.elements,t=e[0],n=e[4],r=e[8],s=e[1],o=e[5],a=e[9],l=e[2],c=e[6],u=e[10];return t*(o*u-a*c)-n*(s*u-a*l)+r*(s*c-o*l)}transpose(){let e=this.elements,t;return t=e[1],e[1]=e[4],e[4]=t,t=e[2],e[2]=e[8],e[8]=t,t=e[6],e[6]=e[9],e[9]=t,t=e[3],e[3]=e[12],e[12]=t,t=e[7],e[7]=e[13],e[13]=t,t=e[11],e[11]=e[14],e[14]=t,this}setPosition(e,t,n){let r=this.elements;return e.isVector3?(r[12]=e.x,r[13]=e.y,r[14]=e.z):(r[12]=e,r[13]=t,r[14]=n),this}invert(){let e=this.elements,t=e[0],n=e[1],r=e[2],s=e[3],o=e[4],a=e[5],l=e[6],c=e[7],u=e[8],f=e[9],h=e[10],d=e[11],p=e[12],v=e[13],g=e[14],m=e[15],y=t*a-n*o,_=t*l-r*o,x=t*c-s*o,S=n*l-r*a,b=n*c-s*a,E=r*c-s*l,M=u*v-f*p,T=u*g-h*p,A=u*m-d*p,I=f*g-h*v,D=f*m-d*v,B=h*m-d*g,F=y*B-_*D+x*I+S*A-b*T+E*M;if(F===0)return this.set(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);let L=1/F;return e[0]=(a*B-l*D+c*I)*L,e[1]=(r*D-n*B-s*I)*L,e[2]=(v*E-g*b+m*S)*L,e[3]=(h*b-f*E-d*S)*L,e[4]=(l*A-o*B-c*T)*L,e[5]=(t*B-r*A+s*T)*L,e[6]=(g*x-p*E-m*_)*L,e[7]=(u*E-h*x+d*_)*L,e[8]=(o*D-a*A+c*M)*L,e[9]=(n*A-t*D-s*M)*L,e[10]=(p*b-v*x+m*y)*L,e[11]=(f*x-u*b-d*y)*L,e[12]=(a*T-o*I-l*M)*L,e[13]=(t*I-n*T+r*M)*L,e[14]=(v*_-p*S-g*y)*L,e[15]=(u*S-f*_+h*y)*L,this}scale(e){let t=this.elements,n=e.x,r=e.y,s=e.z;return t[0]*=n,t[4]*=r,t[8]*=s,t[1]*=n,t[5]*=r,t[9]*=s,t[2]*=n,t[6]*=r,t[10]*=s,t[3]*=n,t[7]*=r,t[11]*=s,this}getMaxScaleOnAxis(){let e=this.elements,t=e[0]*e[0]+e[1]*e[1]+e[2]*e[2],n=e[4]*e[4]+e[5]*e[5]+e[6]*e[6],r=e[8]*e[8]+e[9]*e[9]+e[10]*e[10];return Math.sqrt(Math.max(t,n,r))}makeTranslation(e,t,n){return e.isVector3?this.set(1,0,0,e.x,0,1,0,e.y,0,0,1,e.z,0,0,0,1):this.set(1,0,0,e,0,1,0,t,0,0,1,n,0,0,0,1),this}makeRotationX(e){let t=Math.cos(e),n=Math.sin(e);return this.set(1,0,0,0,0,t,-n,0,0,n,t,0,0,0,0,1),this}makeRotationY(e){let t=Math.cos(e),n=Math.sin(e);return this.set(t,0,n,0,0,1,0,0,-n,0,t,0,0,0,0,1),this}makeRotationZ(e){let t=Math.cos(e),n=Math.sin(e);return this.set(t,-n,0,0,n,t,0,0,0,0,1,0,0,0,0,1),this}makeRotationAxis(e,t){let n=Math.cos(t),r=Math.sin(t),s=1-n,o=e.x,a=e.y,l=e.z,c=s*o,u=s*a;return this.set(c*o+n,c*a-r*l,c*l+r*a,0,c*a+r*l,u*a+n,u*l-r*o,0,c*l-r*a,u*l+r*o,s*l*l+n,0,0,0,0,1),this}makeScale(e,t,n){return this.set(e,0,0,0,0,t,0,0,0,0,n,0,0,0,0,1),this}makeShear(e,t,n,r,s,o){return this.set(1,n,s,0,e,1,o,0,t,r,1,0,0,0,0,1),this}compose(e,t,n){let r=this.elements,s=t._x,o=t._y,a=t._z,l=t._w,c=s+s,u=o+o,f=a+a,h=s*c,d=s*u,p=s*f,v=o*u,g=o*f,m=a*f,y=l*c,_=l*u,x=l*f,S=n.x,b=n.y,E=n.z;return r[0]=(1-(v+m))*S,r[1]=(d+x)*S,r[2]=(p-_)*S,r[3]=0,r[4]=(d-x)*b,r[5]=(1-(h+m))*b,r[6]=(g+y)*b,r[7]=0,r[8]=(p+_)*E,r[9]=(g-y)*E,r[10]=(1-(h+v))*E,r[11]=0,r[12]=e.x,r[13]=e.y,r[14]=e.z,r[15]=1,this}decompose(e,t,n){let r=this.elements;e.x=r[12],e.y=r[13],e.z=r[14];let s=this.determinantAffine();if(s===0)return n.set(1,1,1),t.identity(),this;let o=po.set(r[0],r[1],r[2]).length(),a=po.set(r[4],r[5],r[6]).length(),l=po.set(r[8],r[9],r[10]).length();s<0&&(o=-o),Pi.copy(this);let c=1/o,u=1/a,f=1/l;return Pi.elements[0]*=c,Pi.elements[1]*=c,Pi.elements[2]*=c,Pi.elements[4]*=u,Pi.elements[5]*=u,Pi.elements[6]*=u,Pi.elements[8]*=f,Pi.elements[9]*=f,Pi.elements[10]*=f,t.setFromRotationMatrix(Pi),n.x=o,n.y=a,n.z=l,this}makePerspective(e,t,n,r,s,o,a=Kn,l=!1){let c=this.elements,u=2*s/(t-e),f=2*s/(n-r),h=(t+e)/(t-e),d=(n+r)/(n-r),p,v;if(l)p=s/(o-s),v=o*s/(o-s);else if(a===Kn)p=-(o+s)/(o-s),v=-2*o*s/(o-s);else if(a===Zr)p=-o/(o-s),v=-o*s/(o-s);else throw new Error("THREE.Matrix4.makePerspective(): Invalid coordinate system: "+a);return c[0]=u,c[4]=0,c[8]=h,c[12]=0,c[1]=0,c[5]=f,c[9]=d,c[13]=0,c[2]=0,c[6]=0,c[10]=p,c[14]=v,c[3]=0,c[7]=0,c[11]=-1,c[15]=0,this}makeOrthographic(e,t,n,r,s,o,a=Kn,l=!1){let c=this.elements,u=2/(t-e),f=2/(n-r),h=-(t+e)/(t-e),d=-(n+r)/(n-r),p,v;if(l)p=1/(o-s),v=o/(o-s);else if(a===Kn)p=-2/(o-s),v=-(o+s)/(o-s);else if(a===Zr)p=-1/(o-s),v=-s/(o-s);else throw new Error("THREE.Matrix4.makeOrthographic(): Invalid coordinate system: "+a);return c[0]=u,c[4]=0,c[8]=0,c[12]=h,c[1]=0,c[5]=f,c[9]=0,c[13]=d,c[2]=0,c[6]=0,c[10]=p,c[14]=v,c[3]=0,c[7]=0,c[11]=0,c[15]=1,this}equals(e){let t=this.elements,n=e.elements;for(let r=0;r<16;r++)if(t[r]!==n[r])return!1;return!0}fromArray(e,t=0){for(let n=0;n<16;n++)this.elements[n]=e[n+t];return this}toArray(e=[],t=0){let n=this.elements;return e[t]=n[0],e[t+1]=n[1],e[t+2]=n[2],e[t+3]=n[3],e[t+4]=n[4],e[t+5]=n[5],e[t+6]=n[6],e[t+7]=n[7],e[t+8]=n[8],e[t+9]=n[9],e[t+10]=n[10],e[t+11]=n[11],e[t+12]=n[12],e[t+13]=n[13],e[t+14]=n[14],e[t+15]=n[15],e}};Nf.prototype.isMatrix4=!0;var it=Nf,po=new R,Pi=new it,e_=new R(0,0,0),t_=new R(1,1,1),zr=new R,Uu=new R,si=new R,C0=new it,R0=new Jt,Vn=class i{constructor(e=0,t=0,n=0,r=i.DEFAULT_ORDER){this.isEuler=!0,this._x=e,this._y=t,this._z=n,this._order=r}get x(){return this._x}set x(e){this._x=e,this._onChangeCallback()}get y(){return this._y}set y(e){this._y=e,this._onChangeCallback()}get z(){return this._z}set z(e){this._z=e,this._onChangeCallback()}get order(){return this._order}set order(e){this._order=e,this._onChangeCallback()}set(e,t,n,r=this._order){return this._x=e,this._y=t,this._z=n,this._order=r,this._onChangeCallback(),this}clone(){return new this.constructor(this._x,this._y,this._z,this._order)}copy(e){return this._x=e._x,this._y=e._y,this._z=e._z,this._order=e._order,this._onChangeCallback(),this}setFromRotationMatrix(e,t=this._order,n=!0){let r=e.elements,s=r[0],o=r[4],a=r[8],l=r[1],c=r[5],u=r[9],f=r[2],h=r[6],d=r[10];switch(t){case"XYZ":this._y=Math.asin(ot(a,-1,1)),Math.abs(a)<.9999999?(this._x=Math.atan2(-u,d),this._z=Math.atan2(-o,s)):(this._x=Math.atan2(h,c),this._z=0);break;case"YXZ":this._x=Math.asin(-ot(u,-1,1)),Math.abs(u)<.9999999?(this._y=Math.atan2(a,d),this._z=Math.atan2(l,c)):(this._y=Math.atan2(-f,s),this._z=0);break;case"ZXY":this._x=Math.asin(ot(h,-1,1)),Math.abs(h)<.9999999?(this._y=Math.atan2(-f,d),this._z=Math.atan2(-o,c)):(this._y=0,this._z=Math.atan2(l,s));break;case"ZYX":this._y=Math.asin(-ot(f,-1,1)),Math.abs(f)<.9999999?(this._x=Math.atan2(h,d),this._z=Math.atan2(l,s)):(this._x=0,this._z=Math.atan2(-o,c));break;case"YZX":this._z=Math.asin(ot(l,-1,1)),Math.abs(l)<.9999999?(this._x=Math.atan2(-u,c),this._y=Math.atan2(-f,s)):(this._x=0,this._y=Math.atan2(a,d));break;case"XZY":this._z=Math.asin(-ot(o,-1,1)),Math.abs(o)<.9999999?(this._x=Math.atan2(h,c),this._y=Math.atan2(a,s)):(this._x=Math.atan2(-u,d),this._y=0);break;default:Ge("Euler: .setFromRotationMatrix() encountered an unknown order: "+t)}return this._order=t,n===!0&&this._onChangeCallback(),this}setFromQuaternion(e,t,n){return C0.makeRotationFromQuaternion(e),this.setFromRotationMatrix(C0,t,n)}setFromVector3(e,t=this._order){return this.set(e.x,e.y,e.z,t)}reorder(e){return R0.setFromEuler(this),this.setFromQuaternion(R0,e)}equals(e){return e._x===this._x&&e._y===this._y&&e._z===this._z&&e._order===this._order}fromArray(e){return this._x=e[0],this._y=e[1],this._z=e[2],e[3]!==void 0&&(this._order=e[3]),this._onChangeCallback(),this}toArray(e=[],t=0){return e[t]=this._x,e[t+1]=this._y,e[t+2]=this._z,e[t+3]=this._order,e}_onChange(e){return this._onChangeCallback=e,this}_onChangeCallback(){}*[Symbol.iterator](){yield this._x,yield this._y,yield this._z,yield this._order}};Vn.DEFAULT_ORDER="XYZ";var Cs=class{constructor(){this.mask=1}set(e){this.mask=(1<<e|0)>>>0}enable(e){this.mask|=1<<e|0}enableAll(){this.mask=-1}toggle(e){this.mask^=1<<e|0}disable(e){this.mask&=~(1<<e|0)}disableAll(){this.mask=0}test(e){return(this.mask&e.mask)!==0}isEnabled(e){return(this.mask&(1<<e|0))!==0}},n_=0,P0=new R,mo=new Jt,fr=new it,Bu=new R,$a=new R,i_=new R,r_=new Jt,I0=new R(1,0,0),L0=new R(0,1,0),D0=new R(0,0,1),N0={type:"added"},s_={type:"removed"},go={type:"childadded",child:null},Bd={type:"childremoved",child:null},At=class i extends jn{constructor(){super(),this.isObject3D=!0,Object.defineProperty(this,"id",{value:n_++}),this.uuid=ai(),this.name="",this.type="Object3D",this.parent=null,this.children=[],this.up=i.DEFAULT_UP.clone();let e=new R,t=new Vn,n=new Jt,r=new R(1,1,1);function s(){n.setFromEuler(t,!1)}function o(){t.setFromQuaternion(n,void 0,!1)}t._onChange(s),n._onChange(o),Object.defineProperties(this,{position:{configurable:!0,enumerable:!0,value:e},rotation:{configurable:!0,enumerable:!0,value:t},quaternion:{configurable:!0,enumerable:!0,value:n},scale:{configurable:!0,enumerable:!0,value:r},modelViewMatrix:{value:new it},normalMatrix:{value:new ft}}),this.matrix=new it,this.matrixWorld=new it,this.matrixAutoUpdate=i.DEFAULT_MATRIX_AUTO_UPDATE,this.matrixWorldAutoUpdate=i.DEFAULT_MATRIX_WORLD_AUTO_UPDATE,this.matrixWorldNeedsUpdate=!1,this.layers=new Cs,this.visible=!0,this.castShadow=!1,this.receiveShadow=!1,this.frustumCulled=!0,this.renderOrder=0,this.animations=[],this.customDepthMaterial=void 0,this.customDistanceMaterial=void 0,this.static=!1,this.userData={},this.pivot=null}onBeforeShadow(){}onAfterShadow(){}onBeforeRender(){}onAfterRender(){}applyMatrix4(e){this.matrixAutoUpdate&&this.updateMatrix(),this.matrix.premultiply(e),this.matrix.decompose(this.position,this.quaternion,this.scale)}applyQuaternion(e){return this.quaternion.premultiply(e),this}setRotationFromAxisAngle(e,t){this.quaternion.setFromAxisAngle(e,t)}setRotationFromEuler(e){this.quaternion.setFromEuler(e,!0)}setRotationFromMatrix(e){this.quaternion.setFromRotationMatrix(e)}setRotationFromQuaternion(e){this.quaternion.copy(e)}rotateOnAxis(e,t){return mo.setFromAxisAngle(e,t),this.quaternion.multiply(mo),this}rotateOnWorldAxis(e,t){return mo.setFromAxisAngle(e,t),this.quaternion.premultiply(mo),this}rotateX(e){return this.rotateOnAxis(I0,e)}rotateY(e){return this.rotateOnAxis(L0,e)}rotateZ(e){return this.rotateOnAxis(D0,e)}translateOnAxis(e,t){return P0.copy(e).applyQuaternion(this.quaternion),this.position.add(P0.multiplyScalar(t)),this}translateX(e){return this.translateOnAxis(I0,e)}translateY(e){return this.translateOnAxis(L0,e)}translateZ(e){return this.translateOnAxis(D0,e)}localToWorld(e){return this.updateWorldMatrix(!0,!1),e.applyMatrix4(this.matrixWorld)}worldToLocal(e){return this.updateWorldMatrix(!0,!1),e.applyMatrix4(fr.copy(this.matrixWorld).invert())}lookAt(e,t,n){e.isVector3?Bu.copy(e):Bu.set(e,t,n);let r=this.parent;this.updateWorldMatrix(!0,!1),$a.setFromMatrixPosition(this.matrixWorld),this.isCamera||this.isLight?fr.lookAt($a,Bu,this.up):fr.lookAt(Bu,$a,this.up),this.quaternion.setFromRotationMatrix(fr),r&&(fr.extractRotation(r.matrixWorld),mo.setFromRotationMatrix(fr),this.quaternion.premultiply(mo.invert()))}add(e){if(arguments.length>1){for(let t=0;t<arguments.length;t++)this.add(arguments[t]);return this}return e===this?(Qe("Object3D.add: object can't be added as a child of itself.",e),this):(e&&e.isObject3D?(e.removeFromParent(),e.parent=this,this.children.push(e),e.dispatchEvent(N0),go.child=e,this.dispatchEvent(go),go.child=null):Qe("Object3D.add: object not an instance of THREE.Object3D.",e),this)}remove(e){if(arguments.length>1){for(let n=0;n<arguments.length;n++)this.remove(arguments[n]);return this}let t=this.children.indexOf(e);return t!==-1&&(e.parent=null,this.children.splice(t,1),e.dispatchEvent(s_),Bd.child=e,this.dispatchEvent(Bd),Bd.child=null),this}removeFromParent(){let e=this.parent;return e!==null&&e.remove(this),this}clear(){return this.remove(...this.children)}attach(e){return this.updateWorldMatrix(!0,!1),fr.copy(this.matrixWorld).invert(),e.parent!==null&&(e.parent.updateWorldMatrix(!0,!1),fr.multiply(e.parent.matrixWorld)),e.applyMatrix4(fr),e.removeFromParent(),e.parent=this,this.children.push(e),e.updateWorldMatrix(!1,!0),e.dispatchEvent(N0),go.child=e,this.dispatchEvent(go),go.child=null,this}getObjectById(e){return this.getObjectByProperty("id",e)}getObjectByName(e){return this.getObjectByProperty("name",e)}getObjectByProperty(e,t){if(this[e]===t)return this;for(let n=0,r=this.children.length;n<r;n++){let o=this.children[n].getObjectByProperty(e,t);if(o!==void 0)return o}}getObjectsByProperty(e,t,n=[]){this[e]===t&&n.push(this);let r=this.children;for(let s=0,o=r.length;s<o;s++)r[s].getObjectsByProperty(e,t,n);return n}getWorldPosition(e){return this.updateWorldMatrix(!0,!1),e.setFromMatrixPosition(this.matrixWorld)}getWorldQuaternion(e){return this.updateWorldMatrix(!0,!1),this.matrixWorld.decompose($a,e,i_),e}getWorldScale(e){return this.updateWorldMatrix(!0,!1),this.matrixWorld.decompose($a,r_,e),e}getWorldDirection(e){this.updateWorldMatrix(!0,!1);let t=this.matrixWorld.elements;return e.set(t[8],t[9],t[10]).normalize()}raycast(){}intersectsFrustum(){}traverse(e){e(this);let t=this.children;for(let n=0,r=t.length;n<r;n++)t[n].traverse(e)}traverseVisible(e){if(this.visible===!1)return;e(this);let t=this.children;for(let n=0,r=t.length;n<r;n++)t[n].traverseVisible(e)}traverseAncestors(e){let t=this.parent;t!==null&&(e(t),t.traverseAncestors(e))}updateMatrix(){this.matrix.compose(this.position,this.quaternion,this.scale);let e=this.pivot;if(e!==null){let t=e.x,n=e.y,r=e.z,s=this.matrix.elements;s[12]+=t-s[0]*t-s[4]*n-s[8]*r,s[13]+=n-s[1]*t-s[5]*n-s[9]*r,s[14]+=r-s[2]*t-s[6]*n-s[10]*r}this.matrixWorldNeedsUpdate=!0}updateMatrixWorld(e){this.matrixAutoUpdate&&this.updateMatrix(),(this.matrixWorldNeedsUpdate||e)&&(this.matrixWorldAutoUpdate===!0&&(this.parent===null?this.matrixWorld.copy(this.matrix):this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix)),this.matrixWorldNeedsUpdate=!1,e=!0);let t=this.children;for(let n=0,r=t.length;n<r;n++)t[n].updateMatrixWorld(e)}updateWorldMatrix(e,t,n=!1){let r=this.parent;if(e===!0&&r!==null&&r.updateWorldMatrix(!0,!1),this.matrixAutoUpdate&&this.updateMatrix(),(this.matrixWorldNeedsUpdate||n)&&(this.matrixWorldAutoUpdate===!0&&(this.parent===null?this.matrixWorld.copy(this.matrix):this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix)),this.matrixWorldNeedsUpdate=!1,n=!0),t===!0){let s=this.children;for(let o=0,a=s.length;o<a;o++)s[o].updateWorldMatrix(!1,!0,n)}}toJSON(e){let t=e===void 0||typeof e=="string",n={};t&&(e={geometries:{},materials:{},textures:{},images:{},shapes:{},skeletons:{},animations:{},nodes:{}},n.metadata={version:4.7,type:"Object",generator:"Object3D.toJSON"});let r={};r.uuid=this.uuid,r.type=this.type,r.name=this.name,r.castShadow=this.castShadow,r.receiveShadow=this.receiveShadow,r.visible=this.visible,r.frustumCulled=this.frustumCulled,r.renderOrder=this.renderOrder,r.static=this.static,r.matrixAutoUpdate=this.matrixAutoUpdate,Object.keys(this.userData).length>0&&(r.userData=this.userData),r.layers=this.layers.mask,r.matrix=this.matrix.toArray(),r.up=this.up.toArray(),this.pivot!==null&&(r.pivot=this.pivot.toArray()),this.morphTargetDictionary!==void 0&&(r.morphTargetDictionary=Object.assign({},this.morphTargetDictionary)),this.morphTargetInfluences!==void 0&&(r.morphTargetInfluences=this.morphTargetInfluences.slice()),this.isInstancedMesh&&(r.type="InstancedMesh",r.count=this.count,r.instanceMatrix=this.instanceMatrix.toJSON(),this.instanceColor!==null&&(r.instanceColor=this.instanceColor.toJSON())),this.isBatchedMesh&&(r.type="BatchedMesh",r.perObjectFrustumCulled=this.perObjectFrustumCulled,r.sortObjects=this.sortObjects,r.drawRanges=this._drawRanges,r.reservedRanges=this._reservedRanges,r.geometryInfo=this._geometryInfo.map(a=>({...a,boundingBox:a.boundingBox?a.boundingBox.toJSON():void 0,boundingSphere:a.boundingSphere?a.boundingSphere.toJSON():void 0})),r.instanceInfo=this._instanceInfo.map(a=>({...a})),r.availableInstanceIds=this._availableInstanceIds.slice(),r.availableGeometryIds=this._availableGeometryIds.slice(),r.nextIndexStart=this._nextIndexStart,r.nextVertexStart=this._nextVertexStart,r.geometryCount=this._geometryCount,r.maxInstanceCount=this._maxInstanceCount,r.maxVertexCount=this._maxVertexCount,r.maxIndexCount=this._maxIndexCount,r.geometryInitialized=this._geometryInitialized,r.matricesTexture=this._matricesTexture.toJSON(e),r.indirectTexture=this._indirectTexture.toJSON(e),this._colorsTexture!==null&&(r.colorsTexture=this._colorsTexture.toJSON(e)),this.boundingSphere!==null&&(r.boundingSphere=this.boundingSphere.toJSON()),this.boundingBox!==null&&(r.boundingBox=this.boundingBox.toJSON()));function s(a,l){return a[l.uuid]===void 0&&(a[l.uuid]=l.toJSON(e)),l.uuid}if(this.isScene)this.background&&(this.background.isColor?r.background=this.background.toJSON():this.background.isTexture&&(r.background=this.background.toJSON(e).uuid)),this.environment&&this.environment.isTexture&&this.environment.isRenderTargetTexture!==!0&&(r.environment=this.environment.toJSON(e).uuid);else if(this.isMesh||this.isLine||this.isPoints){r.geometry=s(e.geometries,this.geometry);let a=this.geometry.parameters;if(a!==void 0&&a.shapes!==void 0){let l=a.shapes;if(Array.isArray(l))for(let c=0,u=l.length;c<u;c++){let f=l[c];s(e.shapes,f)}else s(e.shapes,l)}}if(this.isSkinnedMesh&&(r.bindMode=this.bindMode,r.bindMatrix=this.bindMatrix.toArray(),this.skeleton!==void 0&&(s(e.skeletons,this.skeleton),r.skeleton=this.skeleton.uuid)),this.material!==void 0)if(Array.isArray(this.material)){let a=[];for(let l=0,c=this.material.length;l<c;l++)a.push(s(e.materials,this.material[l]));r.material=a}else r.material=s(e.materials,this.material);if(this.children.length>0){r.children=[];for(let a=0;a<this.children.length;a++)r.children.push(this.children[a].toJSON(e).object)}if(this.animations.length>0){r.animations=[];for(let a=0;a<this.animations.length;a++){let l=this.animations[a];r.animations.push(s(e.animations,l))}}if(t){let a=o(e.geometries),l=o(e.materials),c=o(e.textures),u=o(e.images),f=o(e.shapes),h=o(e.skeletons),d=o(e.animations),p=o(e.nodes);a.length>0&&(n.geometries=a),l.length>0&&(n.materials=l),c.length>0&&(n.textures=c),u.length>0&&(n.images=u),f.length>0&&(n.shapes=f),h.length>0&&(n.skeletons=h),d.length>0&&(n.animations=d),p.length>0&&(n.nodes=p)}return n.object=r,n;function o(a){let l=[];for(let c in a){let u=a[c];delete u.metadata,l.push(u)}return l}}clone(e){return new this.constructor().copy(this,e)}copy(e,t=!0){if(this.name=e.name,this.up.copy(e.up),this.position.copy(e.position),this.rotation.order=e.rotation.order,this.quaternion.copy(e.quaternion),this.scale.copy(e.scale),this.pivot=e.pivot!==null?e.pivot.clone():null,this.matrix.copy(e.matrix),this.matrixWorld.copy(e.matrixWorld),this.matrixAutoUpdate=e.matrixAutoUpdate,this.matrixWorldAutoUpdate=e.matrixWorldAutoUpdate,this.matrixWorldNeedsUpdate=e.matrixWorldNeedsUpdate,this.layers.mask=e.layers.mask,this.visible=e.visible,this.castShadow=e.castShadow,this.receiveShadow=e.receiveShadow,this.frustumCulled=e.frustumCulled,this.renderOrder=e.renderOrder,this.static=e.static,this.animations=e.animations.slice(),this.userData=JSON.parse(JSON.stringify(e.userData)),t===!0)for(let n=0;n<e.children.length;n++){let r=e.children[n];this.add(r.clone())}return this}dispose(){this.dispatchEvent({type:"dispose"})}};At.DEFAULT_UP=new R(0,1,0);At.DEFAULT_MATRIX_AUTO_UPDATE=!0;At.DEFAULT_MATRIX_WORLD_AUTO_UPDATE=!0;var kn=class extends At{constructor(){super(),this.isGroup=!0,this.type="Group"}},o_={type:"move"},Rs=class{constructor(){this._targetRay=null,this._grip=null,this._hand=null}getHandSpace(){return this._hand===null&&(this._hand=new kn,this._hand.matrixAutoUpdate=!1,this._hand.visible=!1,this._hand.joints={},this._hand.inputState={pinching:!1}),this._hand}getTargetRaySpace(){return this._targetRay===null&&(this._targetRay=new kn,this._targetRay.matrixAutoUpdate=!1,this._targetRay.visible=!1,this._targetRay.hasLinearVelocity=!1,this._targetRay.linearVelocity=new R,this._targetRay.hasAngularVelocity=!1,this._targetRay.angularVelocity=new R),this._targetRay}getGripSpace(){return this._grip===null&&(this._grip=new kn,this._grip.matrixAutoUpdate=!1,this._grip.visible=!1,this._grip.hasLinearVelocity=!1,this._grip.linearVelocity=new R,this._grip.hasAngularVelocity=!1,this._grip.angularVelocity=new R,this._grip.eventsEnabled=!1),this._grip}dispatchEvent(e){return this._targetRay!==null&&this._targetRay.dispatchEvent(e),this._grip!==null&&this._grip.dispatchEvent(e),this._hand!==null&&this._hand.dispatchEvent(e),this}connect(e){if(e&&e.hand){let t=this._hand;if(t)for(let n of e.hand.values())this._getHandJoint(t,n)}return this.dispatchEvent({type:"connected",data:e}),this}disconnect(e){return this.dispatchEvent({type:"disconnected",data:e}),this._targetRay!==null&&(this._targetRay.visible=!1),this._grip!==null&&(this._grip.visible=!1),this._hand!==null&&(this._hand.visible=!1),this}update(e,t,n){let r=null,s=null,o=null,a=this._targetRay,l=this._grip,c=this._hand;if(e&&t.session.visibilityState!=="visible-blurred"){if(c&&e.hand){o=!0;for(let v of e.hand.values()){let g=t.getJointPose(v,n),m=this._getHandJoint(c,v);g!==null&&(m.matrix.fromArray(g.transform.matrix),m.matrix.decompose(m.position,m.rotation,m.scale),m.matrixWorldNeedsUpdate=!0,m.jointRadius=g.radius),m.visible=g!==null}let u=c.joints["index-finger-tip"],f=c.joints["thumb-tip"],h=u.position.distanceTo(f.position),d=.02,p=.005;c.inputState.pinching&&h>d+p?(c.inputState.pinching=!1,this.dispatchEvent({type:"pinchend",handedness:e.handedness,target:this})):!c.inputState.pinching&&h<=d-p&&(c.inputState.pinching=!0,this.dispatchEvent({type:"pinchstart",handedness:e.handedness,target:this}))}else l!==null&&e.gripSpace&&(s=t.getPose(e.gripSpace,n),s!==null&&(l.matrix.fromArray(s.transform.matrix),l.matrix.decompose(l.position,l.rotation,l.scale),l.matrixWorldNeedsUpdate=!0,s.linearVelocity?(l.hasLinearVelocity=!0,l.linearVelocity.copy(s.linearVelocity)):l.hasLinearVelocity=!1,s.angularVelocity?(l.hasAngularVelocity=!0,l.angularVelocity.copy(s.angularVelocity)):l.hasAngularVelocity=!1,l.eventsEnabled&&l.dispatchEvent({type:"gripUpdated",data:e,target:this})));a!==null&&(r=t.getPose(e.targetRaySpace,n),r===null&&s!==null&&(r=s),r!==null&&(a.matrix.fromArray(r.transform.matrix),a.matrix.decompose(a.position,a.rotation,a.scale),a.matrixWorldNeedsUpdate=!0,r.linearVelocity?(a.hasLinearVelocity=!0,a.linearVelocity.copy(r.linearVelocity)):a.hasLinearVelocity=!1,r.angularVelocity?(a.hasAngularVelocity=!0,a.angularVelocity.copy(r.angularVelocity)):a.hasAngularVelocity=!1,this.dispatchEvent(o_)))}return a!==null&&(a.visible=r!==null),l!==null&&(l.visible=s!==null),c!==null&&(c.visible=o!==null),this}_getHandJoint(e,t){if(e.joints[t.jointName]===void 0){let n=new kn;n.matrixAutoUpdate=!1,n.visible=!1,e.joints[t.jointName]=n,e.add(n)}return e.joints[t.jointName]}},Rv={aliceblue:15792383,antiquewhite:16444375,aqua:65535,aquamarine:8388564,azure:15794175,beige:16119260,bisque:16770244,black:0,blanchedalmond:16772045,blue:255,blueviolet:9055202,brown:10824234,burlywood:14596231,cadetblue:6266528,chartreuse:8388352,chocolate:13789470,coral:16744272,cornflowerblue:6591981,cornsilk:16775388,crimson:14423100,cyan:65535,darkblue:139,darkcyan:35723,darkgoldenrod:12092939,darkgray:11119017,darkgreen:25600,darkgrey:11119017,darkkhaki:12433259,darkmagenta:9109643,darkolivegreen:5597999,darkorange:16747520,darkorchid:10040012,darkred:9109504,darksalmon:15308410,darkseagreen:9419919,darkslateblue:4734347,darkslategray:3100495,darkslategrey:3100495,darkturquoise:52945,darkviolet:9699539,deeppink:16716947,deepskyblue:49151,dimgray:6908265,dimgrey:6908265,dodgerblue:2003199,firebrick:11674146,floralwhite:16775920,forestgreen:2263842,fuchsia:16711935,gainsboro:14474460,ghostwhite:16316671,gold:16766720,goldenrod:14329120,gray:8421504,green:32768,greenyellow:11403055,grey:8421504,honeydew:15794160,hotpink:16738740,indianred:13458524,indigo:4915330,ivory:16777200,khaki:15787660,lavender:15132410,lavenderblush:16773365,lawngreen:8190976,lemonchiffon:16775885,lightblue:11393254,lightcoral:15761536,lightcyan:14745599,lightgoldenrodyellow:16448210,lightgray:13882323,lightgreen:9498256,lightgrey:13882323,lightpink:16758465,lightsalmon:16752762,lightseagreen:2142890,lightskyblue:8900346,lightslategray:7833753,lightslategrey:7833753,lightsteelblue:11584734,lightyellow:16777184,lime:65280,limegreen:3329330,linen:16445670,magenta:16711935,maroon:8388608,mediumaquamarine:6737322,mediumblue:205,mediumorchid:12211667,mediumpurple:9662683,mediumseagreen:3978097,mediumslateblue:8087790,mediumspringgreen:64154,mediumturquoise:4772300,mediumvioletred:13047173,midnightblue:1644912,mintcream:16121850,mistyrose:16770273,moccasin:16770229,navajowhite:16768685,navy:128,oldlace:16643558,olive:8421376,olivedrab:7048739,orange:16753920,orangered:16729344,orchid:14315734,palegoldenrod:15657130,palegreen:10025880,paleturquoise:11529966,palevioletred:14381203,papayawhip:16773077,peachpuff:16767673,peru:13468991,pink:16761035,plum:14524637,powderblue:11591910,purple:8388736,rebeccapurple:6697881,red:16711680,rosybrown:12357519,royalblue:4286945,saddlebrown:9127187,salmon:16416882,sandybrown:16032864,seagreen:3050327,seashell:16774638,sienna:10506797,silver:12632256,skyblue:8900331,slateblue:6970061,slategray:7372944,slategrey:7372944,snow:16775930,springgreen:65407,steelblue:4620980,tan:13808780,teal:32896,thistle:14204888,tomato:16737095,turquoise:4251856,violet:15631086,wheat:16113331,white:16777215,whitesmoke:16119285,yellow:16776960,yellowgreen:10145074},kr={h:0,s:0,l:0},Ou={h:0,s:0,l:0};function Od(i,e,t){return t<0&&(t+=1),t>1&&(t-=1),t<1/6?i+(e-i)*6*t:t<1/2?e:t<2/3?i+(e-i)*6*(2/3-t):i}var be=class{constructor(e,t,n){return this.isColor=!0,this.r=1,this.g=1,this.b=1,this.set(e,t,n)}set(e,t,n){if(t===void 0&&n===void 0){let r=e;r&&r.isColor?this.copy(r):typeof r=="number"?this.setHex(r):typeof r=="string"&&this.setStyle(r)}else this.setRGB(e,t,n);return this}setScalar(e){return this.r=e,this.g=e,this.b=e,this}setHex(e,t=nn){return e=Math.floor(e),this.r=(e>>16&255)/255,this.g=(e>>8&255)/255,this.b=(e&255)/255,vt.colorSpaceToWorking(this,t),this}setRGB(e,t,n,r=vt.workingColorSpace){return this.r=e,this.g=t,this.b=n,vt.colorSpaceToWorking(this,r),this}setHSL(e,t,n,r=vt.workingColorSpace){if(e=pm(e,1),t=ot(t,0,1),n=ot(n,0,1),t===0)this.r=this.g=this.b=n;else{let s=n<=.5?n*(1+t):n+t-n*t,o=2*n-s;this.r=Od(o,s,e+1/3),this.g=Od(o,s,e),this.b=Od(o,s,e-1/3)}return vt.colorSpaceToWorking(this,r),this}setStyle(e,t=nn){function n(s){s!==void 0&&parseFloat(s)<1&&Ge("Color: Alpha component of "+e+" will be ignored.")}let r;if(r=/^(\w+)\(([^\)]*)\)/.exec(e)){let s,o=r[1],a=r[2];switch(o){case"rgb":case"rgba":if(s=/^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(a))return n(s[4]),this.setRGB(Math.min(255,parseInt(s[1],10))/255,Math.min(255,parseInt(s[2],10))/255,Math.min(255,parseInt(s[3],10))/255,t);if(s=/^\s*(\d+)\%\s*,\s*(\d+)\%\s*,\s*(\d+)\%\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(a))return n(s[4]),this.setRGB(Math.min(100,parseInt(s[1],10))/100,Math.min(100,parseInt(s[2],10))/100,Math.min(100,parseInt(s[3],10))/100,t);break;case"hsl":case"hsla":if(s=/^\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\%\s*,\s*(\d*\.?\d+)\%\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(a))return n(s[4]),this.setHSL(parseFloat(s[1])/360,parseFloat(s[2])/100,parseFloat(s[3])/100,t);break;default:Ge("Color: Unknown color model "+e)}}else if(r=/^\#([A-Fa-f\d]+)$/.exec(e)){let s=r[1],o=s.length;if(o===3)return this.setRGB(parseInt(s.charAt(0),16)/15,parseInt(s.charAt(1),16)/15,parseInt(s.charAt(2),16)/15,t);if(o===6)return this.setHex(parseInt(s,16),t);Ge("Color: Invalid hex color "+e)}else if(e&&e.length>0)return this.setColorName(e,t);return this}setColorName(e,t=nn){let n=Rv[e.toLowerCase()];return n!==void 0?this.setHex(n,t):Ge("Color: Unknown color "+e),this}clone(){return new this.constructor(this.r,this.g,this.b)}copy(e){return this.r=e.r,this.g=e.g,this.b=e.b,this}copySRGBToLinear(e){return this.r=yr(e.r),this.g=yr(e.g),this.b=yr(e.b),this}copyLinearToSRGB(e){return this.r=No(e.r),this.g=No(e.g),this.b=No(e.b),this}convertSRGBToLinear(){return this.copySRGBToLinear(this),this}convertLinearToSRGB(){return this.copyLinearToSRGB(this),this}getHex(e=nn){return vt.workingToColorSpace(En.copy(this),e),Math.round(ot(En.r*255,0,255))*65536+Math.round(ot(En.g*255,0,255))*256+Math.round(ot(En.b*255,0,255))}getHexString(e=nn){return("000000"+this.getHex(e).toString(16)).slice(-6)}getHSL(e,t=vt.workingColorSpace){vt.workingToColorSpace(En.copy(this),t);let n=En.r,r=En.g,s=En.b,o=Math.max(n,r,s),a=Math.min(n,r,s),l,c,u=(a+o)/2;if(a===o)l=0,c=0;else{let f=o-a;switch(c=u<=.5?f/(o+a):f/(2-o-a),o){case n:l=(r-s)/f+(r<s?6:0);break;case r:l=(s-n)/f+2;break;case s:l=(n-r)/f+4;break}l/=6}return e.h=l,e.s=c,e.l=u,e}getRGB(e,t=vt.workingColorSpace){return vt.workingToColorSpace(En.copy(this),t),e.r=En.r,e.g=En.g,e.b=En.b,e}getStyle(e=nn){vt.workingToColorSpace(En.copy(this),e);let t=En.r,n=En.g,r=En.b;return e!==nn?`color(${e} ${t.toFixed(3)} ${n.toFixed(3)} ${r.toFixed(3)})`:`rgb(${Math.round(t*255)},${Math.round(n*255)},${Math.round(r*255)})`}offsetHSL(e,t,n){return this.getHSL(kr),this.setHSL(kr.h+e,kr.s+t,kr.l+n)}add(e){return this.r+=e.r,this.g+=e.g,this.b+=e.b,this}addColors(e,t){return this.r=e.r+t.r,this.g=e.g+t.g,this.b=e.b+t.b,this}addScalar(e){return this.r+=e,this.g+=e,this.b+=e,this}sub(e){return this.r=Math.max(0,this.r-e.r),this.g=Math.max(0,this.g-e.g),this.b=Math.max(0,this.b-e.b),this}multiply(e){return this.r*=e.r,this.g*=e.g,this.b*=e.b,this}multiplyScalar(e){return this.r*=e,this.g*=e,this.b*=e,this}lerp(e,t){return this.r+=(e.r-this.r)*t,this.g+=(e.g-this.g)*t,this.b+=(e.b-this.b)*t,this}lerpColors(e,t,n){return this.r=e.r+(t.r-e.r)*n,this.g=e.g+(t.g-e.g)*n,this.b=e.b+(t.b-e.b)*n,this}lerpHSL(e,t){this.getHSL(kr),e.getHSL(Ou);let n=hl(kr.h,Ou.h,t),r=hl(kr.s,Ou.s,t),s=hl(kr.l,Ou.l,t);return this.setHSL(n,r,s),this}setFromVector3(e){return this.r=e.x,this.g=e.y,this.b=e.z,this}applyMatrix3(e){let t=this.r,n=this.g,r=this.b,s=e.elements;return this.r=s[0]*t+s[3]*n+s[6]*r,this.g=s[1]*t+s[4]*n+s[7]*r,this.b=s[2]*t+s[5]*n+s[8]*r,this}equals(e){return e.r===this.r&&e.g===this.g&&e.b===this.b}fromArray(e,t=0){return this.r=e[t],this.g=e[t+1],this.b=e[t+2],this}toArray(e=[],t=0){return e[t]=this.r,e[t+1]=this.g,e[t+2]=this.b,e}fromBufferAttribute(e,t){return this.r=e.getX(t),this.g=e.getY(t),this.b=e.getZ(t),this}toJSON(){return this.getHex()}*[Symbol.iterator](){yield this.r,yield this.g,yield this.b}},En=new be;be.NAMES=Rv;var Ps=class i{constructor(e,t=25e-5){this.isFogExp2=!0,this.name="",this.color=new be(e),this.density=t}clone(){return new i(this.color,this.density)}toJSON(){return{type:"FogExp2",name:this.name,color:this.color.getHex(),density:this.density}}},wl=class i{constructor(e,t=1,n=1e3){this.isFog=!0,this.name="",this.color=new be(e),this.near=t,this.far=n}clone(){return new i(this.color,this.near,this.far)}toJSON(){return{type:"Fog",name:this.name,color:this.color.getHex(),near:this.near,far:this.far}}},li=class extends At{constructor(){super(),this.isScene=!0,this.type="Scene",this.background=null,this.environment=null,this.fog=null,this.backgroundBlurriness=0,this.backgroundIntensity=1,this.backgroundRotation=new Vn,this.environmentIntensity=1,this.environmentRotation=new Vn,this.overrideMaterial=null,typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}copy(e,t){return super.copy(e,t),e.background!==null&&(this.background=e.background.clone()),e.environment!==null&&(this.environment=e.environment.clone()),e.fog!==null&&(this.fog=e.fog.clone()),this.backgroundBlurriness=e.backgroundBlurriness,this.backgroundIntensity=e.backgroundIntensity,this.backgroundRotation.copy(e.backgroundRotation),this.environmentIntensity=e.environmentIntensity,this.environmentRotation.copy(e.environmentRotation),e.overrideMaterial!==null&&(this.overrideMaterial=e.overrideMaterial.clone()),this.matrixAutoUpdate=e.matrixAutoUpdate,this}toJSON(e){let t=super.toJSON(e);return this.fog!==null&&(t.object.fog=this.fog.toJSON()),t.object.backgroundBlurriness=this.backgroundBlurriness,t.object.backgroundIntensity=this.backgroundIntensity,t.object.backgroundRotation=this.backgroundRotation.toArray(),t.object.environmentIntensity=this.environmentIntensity,t.object.environmentRotation=this.environmentRotation.toArray(),t}},Ii=new R,dr=new R,zd=new R,pr=new R,vo=new R,xo=new R,F0=new R,kd=new R,Gd=new R,Vd=new R,Hd=new Pt,Wd=new Pt,Xd=new Pt,Ni=class i{constructor(e=new R,t=new R,n=new R){this.a=e,this.b=t,this.c=n}static getNormal(e,t,n,r){r.subVectors(n,t),Ii.subVectors(e,t),r.cross(Ii);let s=r.lengthSq();return s>0?r.multiplyScalar(1/Math.sqrt(s)):r.set(0,0,0)}static getBarycoord(e,t,n,r,s){Ii.subVectors(r,t),dr.subVectors(n,t),zd.subVectors(e,t);let o=Ii.dot(Ii),a=Ii.dot(dr),l=Ii.dot(zd),c=dr.dot(dr),u=dr.dot(zd),f=o*c-a*a;if(f===0)return s.set(0,0,0),null;let h=1/f,d=(c*l-a*u)*h,p=(o*u-a*l)*h;return s.set(1-d-p,p,d)}static containsPoint(e,t,n,r){return this.getBarycoord(e,t,n,r,pr)===null?!1:pr.x>=0&&pr.y>=0&&pr.x+pr.y<=1}static getInterpolation(e,t,n,r,s,o,a,l){return this.getBarycoord(e,t,n,r,pr)===null?(l.x=0,l.y=0,"z"in l&&(l.z=0),"w"in l&&(l.w=0),null):(l.setScalar(0),l.addScaledVector(s,pr.x),l.addScaledVector(o,pr.y),l.addScaledVector(a,pr.z),l)}static getInterpolatedAttribute(e,t,n,r,s,o){return Hd.setScalar(0),Wd.setScalar(0),Xd.setScalar(0),Hd.fromBufferAttribute(e,t),Wd.fromBufferAttribute(e,n),Xd.fromBufferAttribute(e,r),o.setScalar(0),o.addScaledVector(Hd,s.x),o.addScaledVector(Wd,s.y),o.addScaledVector(Xd,s.z),o}static isFrontFacing(e,t,n,r){return Ii.subVectors(n,t),dr.subVectors(e,t),Ii.cross(dr).dot(r)<0}set(e,t,n){return this.a.copy(e),this.b.copy(t),this.c.copy(n),this}setFromPointsAndIndices(e,t,n,r){return this.a.copy(e[t]),this.b.copy(e[n]),this.c.copy(e[r]),this}setFromAttributeAndIndices(e,t,n,r){return this.a.fromBufferAttribute(e,t),this.b.fromBufferAttribute(e,n),this.c.fromBufferAttribute(e,r),this}clone(){return new this.constructor().copy(this)}copy(e){return this.a.copy(e.a),this.b.copy(e.b),this.c.copy(e.c),this}getArea(){return Ii.subVectors(this.c,this.b),dr.subVectors(this.a,this.b),Ii.cross(dr).length()*.5}getMidpoint(e){return e.addVectors(this.a,this.b).add(this.c).multiplyScalar(1/3)}getNormal(e){return i.getNormal(this.a,this.b,this.c,e)}getPlane(e){return e.setFromCoplanarPoints(this.a,this.b,this.c)}getBarycoord(e,t){return i.getBarycoord(e,this.a,this.b,this.c,t)}getInterpolation(e,t,n,r,s){return i.getInterpolation(e,this.a,this.b,this.c,t,n,r,s)}containsPoint(e){return i.containsPoint(e,this.a,this.b,this.c)}isFrontFacing(e){return i.isFrontFacing(this.a,this.b,this.c,e)}intersectsBox(e){return e.intersectsTriangle(this)}closestPointToPoint(e,t){let n=this.a,r=this.b,s=this.c,o,a;vo.subVectors(r,n),xo.subVectors(s,n),kd.subVectors(e,n);let l=vo.dot(kd),c=xo.dot(kd);if(l<=0&&c<=0)return t.copy(n);Gd.subVectors(e,r);let u=vo.dot(Gd),f=xo.dot(Gd);if(u>=0&&f<=u)return t.copy(r);let h=l*f-u*c;if(h<=0&&l>=0&&u<=0)return o=l/(l-u),t.copy(n).addScaledVector(vo,o);Vd.subVectors(e,s);let d=vo.dot(Vd),p=xo.dot(Vd);if(p>=0&&d<=p)return t.copy(s);let v=d*c-l*p;if(v<=0&&c>=0&&p<=0)return a=c/(c-p),t.copy(n).addScaledVector(xo,a);let g=u*p-d*f;if(g<=0&&f-u>=0&&d-p>=0)return F0.subVectors(s,r),a=(f-u)/(f-u+(d-p)),t.copy(r).addScaledVector(F0,a);let m=1/(g+v+h);return o=v*m,a=h*m,t.copy(n).addScaledVector(vo,o).addScaledVector(xo,a)}equals(e){return e.a.equals(this.a)&&e.b.equals(this.b)&&e.c.equals(this.c)}},cn=class{constructor(e=new R(1/0,1/0,1/0),t=new R(-1/0,-1/0,-1/0)){this.isBox3=!0,this.min=e,this.max=t}set(e,t){return this.min.copy(e),this.max.copy(t),this}setFromArray(e){this.makeEmpty();for(let t=0,n=e.length;t<n;t+=3)this.expandByPoint(Li.fromArray(e,t));return this}setFromBufferAttribute(e){this.makeEmpty();for(let t=0,n=e.count;t<n;t++)this.expandByPoint(Li.fromBufferAttribute(e,t));return this}setFromPoints(e){this.makeEmpty();for(let t=0,n=e.length;t<n;t++)this.expandByPoint(e[t]);return this}setFromCenterAndSize(e,t){let n=Li.copy(t).multiplyScalar(.5);return this.min.copy(e).sub(n),this.max.copy(e).add(n),this}setFromObject(e,t=!1){return this.makeEmpty(),this.expandByObject(e,t)}clone(){return new this.constructor().copy(this)}copy(e){return this.min.copy(e.min),this.max.copy(e.max),this}makeEmpty(){return this.min.x=this.min.y=this.min.z=1/0,this.max.x=this.max.y=this.max.z=-1/0,this}isEmpty(){return this.max.x<this.min.x||this.max.y<this.min.y||this.max.z<this.min.z}getCenter(e){return this.isEmpty()?e.set(0,0,0):e.addVectors(this.min,this.max).multiplyScalar(.5)}getSize(e){return this.isEmpty()?e.set(0,0,0):e.subVectors(this.max,this.min)}expandByPoint(e){return this.min.min(e),this.max.max(e),this}expandByVector(e){return this.min.sub(e),this.max.add(e),this}expandByScalar(e){return this.min.addScalar(-e),this.max.addScalar(e),this}expandByObject(e,t=!1){e.updateWorldMatrix(!1,!1);let n=e.geometry;if(n!==void 0){let s=n.getAttribute("position");if(t===!0&&s!==void 0&&e.isInstancedMesh!==!0)for(let o=0,a=s.count;o<a;o++)e.isMesh===!0?e.getVertexPosition(o,Li):Li.fromBufferAttribute(s,o),Li.applyMatrix4(e.matrixWorld),this.expandByPoint(Li);else e.boundingBox!==void 0?(e.boundingBox===null&&e.computeBoundingBox(),zu.copy(e.boundingBox)):(n.boundingBox===null&&n.computeBoundingBox(),zu.copy(n.boundingBox)),zu.applyMatrix4(e.matrixWorld),this.union(zu)}let r=e.children;for(let s=0,o=r.length;s<o;s++)this.expandByObject(r[s],t);return this}containsPoint(e){return e.x>=this.min.x&&e.x<=this.max.x&&e.y>=this.min.y&&e.y<=this.max.y&&e.z>=this.min.z&&e.z<=this.max.z}containsBox(e){return this.min.x<=e.min.x&&e.max.x<=this.max.x&&this.min.y<=e.min.y&&e.max.y<=this.max.y&&this.min.z<=e.min.z&&e.max.z<=this.max.z}getParameter(e,t){return t.set((e.x-this.min.x)/(this.max.x-this.min.x),(e.y-this.min.y)/(this.max.y-this.min.y),(e.z-this.min.z)/(this.max.z-this.min.z))}intersectsBox(e){return e.max.x>=this.min.x&&e.min.x<=this.max.x&&e.max.y>=this.min.y&&e.min.y<=this.max.y&&e.max.z>=this.min.z&&e.min.z<=this.max.z}intersectsSphere(e){return this.clampPoint(e.center,Li),Li.distanceToSquared(e.center)<=e.radius*e.radius}intersectsPlane(e){let t,n;return e.normal.x>0?(t=e.normal.x*this.min.x,n=e.normal.x*this.max.x):(t=e.normal.x*this.max.x,n=e.normal.x*this.min.x),e.normal.y>0?(t+=e.normal.y*this.min.y,n+=e.normal.y*this.max.y):(t+=e.normal.y*this.max.y,n+=e.normal.y*this.min.y),e.normal.z>0?(t+=e.normal.z*this.min.z,n+=e.normal.z*this.max.z):(t+=e.normal.z*this.max.z,n+=e.normal.z*this.min.z),t<=-e.constant&&n>=-e.constant}intersectsTriangle(e){if(this.isEmpty())return!1;this.getCenter(Ja),ku.subVectors(this.max,Ja),yo.subVectors(e.a,Ja),_o.subVectors(e.b,Ja),Mo.subVectors(e.c,Ja),Gr.subVectors(_o,yo),Vr.subVectors(Mo,_o),hs.subVectors(yo,Mo);let t=[0,-Gr.z,Gr.y,0,-Vr.z,Vr.y,0,-hs.z,hs.y,Gr.z,0,-Gr.x,Vr.z,0,-Vr.x,hs.z,0,-hs.x,-Gr.y,Gr.x,0,-Vr.y,Vr.x,0,-hs.y,hs.x,0];return!qd(t,yo,_o,Mo,ku)||(t=[1,0,0,0,1,0,0,0,1],!qd(t,yo,_o,Mo,ku))?!1:(Gu.crossVectors(Gr,Vr),t=[Gu.x,Gu.y,Gu.z],qd(t,yo,_o,Mo,ku))}clampPoint(e,t){return t.copy(e).clamp(this.min,this.max)}distanceToPoint(e){return this.clampPoint(e,Li).distanceTo(e)}getBoundingSphere(e){return this.isEmpty()?e.makeEmpty():(this.getCenter(e.center),e.radius=this.getSize(Li).length()*.5),e}intersect(e){return this.min.max(e.min),this.max.min(e.max),this.isEmpty()&&this.makeEmpty(),this}union(e){return this.min.min(e.min),this.max.max(e.max),this}applyMatrix4(e){return this.isEmpty()?this:(mr[0].set(this.min.x,this.min.y,this.min.z).applyMatrix4(e),mr[1].set(this.min.x,this.min.y,this.max.z).applyMatrix4(e),mr[2].set(this.min.x,this.max.y,this.min.z).applyMatrix4(e),mr[3].set(this.min.x,this.max.y,this.max.z).applyMatrix4(e),mr[4].set(this.max.x,this.min.y,this.min.z).applyMatrix4(e),mr[5].set(this.max.x,this.min.y,this.max.z).applyMatrix4(e),mr[6].set(this.max.x,this.max.y,this.min.z).applyMatrix4(e),mr[7].set(this.max.x,this.max.y,this.max.z).applyMatrix4(e),this.setFromPoints(mr),this)}translate(e){return this.min.add(e),this.max.add(e),this}equals(e){return e.min.equals(this.min)&&e.max.equals(this.max)}toJSON(){return{min:this.min.toArray(),max:this.max.toArray()}}fromJSON(e){return this.min.fromArray(e.min),this.max.fromArray(e.max),this}},mr=[new R,new R,new R,new R,new R,new R,new R,new R],Li=new R,zu=new cn,yo=new R,_o=new R,Mo=new R,Gr=new R,Vr=new R,hs=new R,Ja=new R,ku=new R,Gu=new R,fs=new R;function qd(i,e,t,n,r){for(let s=0,o=i.length-3;s<=o;s+=3){fs.fromArray(i,s);let a=r.x*Math.abs(fs.x)+r.y*Math.abs(fs.y)+r.z*Math.abs(fs.z),l=e.dot(fs),c=t.dot(fs),u=n.dot(fs);if(Math.max(-Math.max(l,c,u),Math.min(l,c,u))>a)return!1}return!0}var xr=a_();function a_(){let i=new ArrayBuffer(4),e=new Float32Array(i),t=new Uint32Array(i),n=new Uint32Array(512),r=new Uint32Array(512);for(let l=0;l<256;++l){let c=l-127;c<-27?(n[l]=0,n[l|256]=32768,r[l]=24,r[l|256]=24):c<-14?(n[l]=1024>>-c-14,n[l|256]=1024>>-c-14|32768,r[l]=-c-1,r[l|256]=-c-1):c<=15?(n[l]=c+15<<10,n[l|256]=c+15<<10|32768,r[l]=13,r[l|256]=13):c<128?(n[l]=31744,n[l|256]=64512,r[l]=24,r[l|256]=24):(n[l]=31744,n[l|256]=64512,r[l]=13,r[l|256]=13)}let s=new Uint32Array(2048),o=new Uint32Array(64),a=new Uint32Array(64);for(let l=1;l<1024;++l){let c=l<<13,u=0;for(;(c&8388608)===0;)c<<=1,u-=8388608;c&=-8388609,u+=947912704,s[l]=c|u}for(let l=1024;l<2048;++l)s[l]=939524096+(l-1024<<13);for(let l=1;l<31;++l)o[l]=l<<23;o[31]=1199570944,o[32]=2147483648;for(let l=33;l<63;++l)o[l]=2147483648+(l-32<<23);o[63]=3347054592;for(let l=1;l<64;++l)l!==32&&(a[l]=1024);return{floatView:e,uint32View:t,baseTable:n,shiftTable:r,mantissaTable:s,exponentTable:o,offsetTable:a}}function Jn(i){Math.abs(i)>65504&&Ge("DataUtils.toHalfFloat(): Value out of range."),i=ot(i,-65504,65504),xr.floatView[0]=i;let e=xr.uint32View[0],t=e>>23&511;return xr.baseTable[t]+((e&8388607)>>xr.shiftTable[t])}function al(i){let e=i>>10;return xr.uint32View[0]=xr.mantissaTable[xr.offsetTable[e]+(i&1023)]+xr.exponentTable[e],xr.floatView[0]}var Ph=class{static toHalfFloat(e){return Jn(e)}static fromHalfFloat(e){return al(e)}},sn=new R,Vu=new he,l_=0,ht=class extends jn{constructor(e,t,n=!1){if(super(),Array.isArray(e))throw new TypeError("THREE.BufferAttribute: array should be a Typed Array.");this.isBufferAttribute=!0,Object.defineProperty(this,"id",{value:l_++}),this.name="",this.array=e,this.itemSize=t,this.count=e!==void 0?e.length/t:0,this.normalized=n,this.usage=js,this.updateRanges=[],this.gpuType=Rn,this.version=0}onUploadCallback(){}set needsUpdate(e){e===!0&&this.version++}setUsage(e){return this.usage=e,this}addUpdateRange(e,t){this.updateRanges.push({start:e,count:t})}clearUpdateRanges(){this.updateRanges.length=0}copy(e){return this.name=e.name,this.array=new e.array.constructor(e.array),this.itemSize=e.itemSize,this.count=e.count,this.normalized=e.normalized,this.usage=e.usage,this.gpuType=e.gpuType,this}copyAt(e,t,n){e*=this.itemSize,n*=t.itemSize;for(let r=0,s=this.itemSize;r<s;r++)this.array[e+r]=t.array[n+r];return this}copyArray(e){return this.array.set(e),this}applyMatrix3(e){if(this.itemSize===2)for(let t=0,n=this.count;t<n;t++)Vu.fromBufferAttribute(this,t),Vu.applyMatrix3(e),this.setXY(t,Vu.x,Vu.y);else if(this.itemSize===3)for(let t=0,n=this.count;t<n;t++)sn.fromBufferAttribute(this,t),sn.applyMatrix3(e),this.setXYZ(t,sn.x,sn.y,sn.z);return this}applyMatrix4(e){for(let t=0,n=this.count;t<n;t++)sn.fromBufferAttribute(this,t),sn.applyMatrix4(e),this.setXYZ(t,sn.x,sn.y,sn.z);return this}applyNormalMatrix(e){for(let t=0,n=this.count;t<n;t++)sn.fromBufferAttribute(this,t),sn.applyNormalMatrix(e),this.setXYZ(t,sn.x,sn.y,sn.z);return this}transformDirection(e){for(let t=0,n=this.count;t<n;t++)sn.fromBufferAttribute(this,t),sn.transformDirection(e),this.setXYZ(t,sn.x,sn.y,sn.z);return this}set(e,t=0){return this.array.set(e,t),this}getComponent(e,t){let n=this.array[e*this.itemSize+t];return this.normalized&&(n=On(n,this.array)),n}setComponent(e,t,n){return this.normalized&&(n=mt(n,this.array)),this.array[e*this.itemSize+t]=n,this}getX(e){let t=this.array[e*this.itemSize];return this.normalized&&(t=On(t,this.array)),t}setX(e,t){return this.normalized&&(t=mt(t,this.array)),this.array[e*this.itemSize]=t,this}getY(e){let t=this.array[e*this.itemSize+1];return this.normalized&&(t=On(t,this.array)),t}setY(e,t){return this.normalized&&(t=mt(t,this.array)),this.array[e*this.itemSize+1]=t,this}getZ(e){let t=this.array[e*this.itemSize+2];return this.normalized&&(t=On(t,this.array)),t}setZ(e,t){return this.normalized&&(t=mt(t,this.array)),this.array[e*this.itemSize+2]=t,this}getW(e){let t=this.array[e*this.itemSize+3];return this.normalized&&(t=On(t,this.array)),t}setW(e,t){return this.normalized&&(t=mt(t,this.array)),this.array[e*this.itemSize+3]=t,this}setXY(e,t,n){return e*=this.itemSize,this.normalized&&(t=mt(t,this.array),n=mt(n,this.array)),this.array[e+0]=t,this.array[e+1]=n,this}setXYZ(e,t,n,r){return e*=this.itemSize,this.normalized&&(t=mt(t,this.array),n=mt(n,this.array),r=mt(r,this.array)),this.array[e+0]=t,this.array[e+1]=n,this.array[e+2]=r,this}setXYZW(e,t,n,r,s){return e*=this.itemSize,this.normalized&&(t=mt(t,this.array),n=mt(n,this.array),r=mt(r,this.array),s=mt(s,this.array)),this.array[e+0]=t,this.array[e+1]=n,this.array[e+2]=r,this.array[e+3]=s,this}onUpload(e){return this.onUploadCallback=e,this}clone(){return new this.constructor(this.array,this.itemSize).copy(this)}toJSON(){let e={itemSize:this.itemSize,type:this.array.constructor.name,array:Array.from(this.array),normalized:this.normalized};return e.name=this.name,e.usage=this.usage,e.gpuType=this.gpuType,e}dispose(){this.dispatchEvent({type:"dispose"})}},Ih=class extends ht{constructor(e,t,n){super(new Int8Array(e),t,n)}},Lh=class extends ht{constructor(e,t,n){super(new Uint8Array(e),t,n)}},Dh=class extends ht{constructor(e,t,n){super(new Uint8ClampedArray(e),t,n)}},Nh=class extends ht{constructor(e,t,n){super(new Int16Array(e),t,n)}},Ho=class extends ht{constructor(e,t,n){super(new Uint16Array(e),t,n)}},Fh=class extends ht{constructor(e,t,n){super(new Int32Array(e),t,n)}},Wo=class extends ht{constructor(e,t,n){super(new Uint32Array(e),t,n)}},Uh=class extends ht{constructor(e,t,n){super(new Uint16Array(e),t,n),this.isFloat16BufferAttribute=!0}getX(e){let t=al(this.array[e*this.itemSize]);return this.normalized&&(t=On(t,this.array)),t}setX(e,t){return this.normalized&&(t=mt(t,this.array)),this.array[e*this.itemSize]=Jn(t),this}getY(e){let t=al(this.array[e*this.itemSize+1]);return this.normalized&&(t=On(t,this.array)),t}setY(e,t){return this.normalized&&(t=mt(t,this.array)),this.array[e*this.itemSize+1]=Jn(t),this}getZ(e){let t=al(this.array[e*this.itemSize+2]);return this.normalized&&(t=On(t,this.array)),t}setZ(e,t){return this.normalized&&(t=mt(t,this.array)),this.array[e*this.itemSize+2]=Jn(t),this}getW(e){let t=al(this.array[e*this.itemSize+3]);return this.normalized&&(t=On(t,this.array)),t}setW(e,t){return this.normalized&&(t=mt(t,this.array)),this.array[e*this.itemSize+3]=Jn(t),this}setXY(e,t,n){return e*=this.itemSize,this.normalized&&(t=mt(t,this.array),n=mt(n,this.array)),this.array[e+0]=Jn(t),this.array[e+1]=Jn(n),this}setXYZ(e,t,n,r){return e*=this.itemSize,this.normalized&&(t=mt(t,this.array),n=mt(n,this.array),r=mt(r,this.array)),this.array[e+0]=Jn(t),this.array[e+1]=Jn(n),this.array[e+2]=Jn(r),this}setXYZW(e,t,n,r,s){return e*=this.itemSize,this.normalized&&(t=mt(t,this.array),n=mt(n,this.array),r=mt(r,this.array),s=mt(s,this.array)),this.array[e+0]=Jn(t),this.array[e+1]=Jn(n),this.array[e+2]=Jn(r),this.array[e+3]=Jn(s),this}},Ve=class extends ht{constructor(e,t,n){super(new Float32Array(e),t,n)}},c_=new cn,Ka=new R,Yd=new R,on=class{constructor(e=new R,t=-1){this.isSphere=!0,this.center=e,this.radius=t}set(e,t){return this.center.copy(e),this.radius=t,this}setFromPoints(e,t){let n=this.center;t!==void 0?n.copy(t):c_.setFromPoints(e).getCenter(n);let r=0;for(let s=0,o=e.length;s<o;s++)r=Math.max(r,n.distanceToSquared(e[s]));return this.radius=Math.sqrt(r),this}copy(e){return this.center.copy(e.center),this.radius=e.radius,this}isEmpty(){return this.radius<0}makeEmpty(){return this.center.set(0,0,0),this.radius=-1,this}containsPoint(e){return e.distanceToSquared(this.center)<=this.radius*this.radius}distanceToPoint(e){return e.distanceTo(this.center)-this.radius}intersectsSphere(e){let t=this.radius+e.radius;return e.center.distanceToSquared(this.center)<=t*t}intersectsBox(e){return e.intersectsSphere(this)}intersectsPlane(e){return Math.abs(e.distanceToPoint(this.center))<=this.radius}clampPoint(e,t){let n=this.center.distanceToSquared(e);return t.copy(e),n>this.radius*this.radius&&(t.sub(this.center).normalize(),t.multiplyScalar(this.radius).add(this.center)),t}getBoundingBox(e){return this.isEmpty()?(e.makeEmpty(),e):(e.set(this.center,this.center),e.expandByScalar(this.radius),e)}applyMatrix4(e){return this.center.applyMatrix4(e),this.radius=this.radius*e.getMaxScaleOnAxis(),this}translate(e){return this.center.add(e),this}expandByPoint(e){if(this.isEmpty())return this.center.copy(e),this.radius=0,this;Ka.subVectors(e,this.center);let t=Ka.lengthSq();if(t>this.radius*this.radius){let n=Math.sqrt(t),r=(n-this.radius)*.5;this.center.addScaledVector(Ka,r/n),this.radius+=r}return this}union(e){return e.isEmpty()?this:this.isEmpty()?(this.copy(e),this):(this.center.equals(e.center)===!0?this.radius=Math.max(this.radius,e.radius):(Yd.subVectors(e.center,this.center).setLength(e.radius),this.expandByPoint(Ka.copy(e.center).add(Yd)),this.expandByPoint(Ka.copy(e.center).sub(Yd))),this)}equals(e){return e.center.equals(this.center)&&e.radius===this.radius}clone(){return new this.constructor().copy(this)}toJSON(){return{radius:this.radius,center:this.center.toArray()}}fromJSON(e){return this.radius=e.radius,this.center.fromArray(e.center),this}},u_=0,_i=new it,Zd=new At,So=new R,oi=new cn,ja=new cn,fn=new R,et=class i extends jn{constructor(){super(),this.isBufferGeometry=!0,Object.defineProperty(this,"id",{value:u_++}),this.uuid=ai(),this.name="",this.type="BufferGeometry",this.index=null,this.indirect=null,this.indirectOffset=0,this.attributes={},this.morphAttributes={},this.morphTargetsRelative=!1,this.groups=[],this.boundingBox=null,this.boundingSphere=null,this.drawRange={start:0,count:1/0},this.userData={},this._transformed=!1}getIndex(){return this.index}setIndex(e){return Array.isArray(e)?this.index=new(Dy(e)?Wo:Ho)(e,1):this.index=e,this}setIndirect(e,t=0){return this.indirect=e,this.indirectOffset=t,this}getIndirect(){return this.indirect}getAttribute(e){return this.attributes[e]}setAttribute(e,t){return this.attributes[e]=t,this}deleteAttribute(e){return delete this.attributes[e],this}hasAttribute(e){return this.attributes[e]!==void 0}addGroup(e,t,n=0){this.groups.push({start:e,count:t,materialIndex:n})}clearGroups(){this.groups=[]}setDrawRange(e,t){this.drawRange.start=e,this.drawRange.count=t}applyMatrix4(e){let t=this.attributes.position;t!==void 0&&(t.applyMatrix4(e),t.needsUpdate=!0);let n=this.attributes.normal;if(n!==void 0){let s=new ft().getNormalMatrix(e);n.applyNormalMatrix(s),n.needsUpdate=!0}let r=this.attributes.tangent;return r!==void 0&&(r.transformDirection(e),r.needsUpdate=!0),this.boundingBox!==null&&this.computeBoundingBox(),this.boundingSphere!==null&&this.computeBoundingSphere(),this._transformed=!0,this}applyQuaternion(e){return _i.makeRotationFromQuaternion(e),this.applyMatrix4(_i),this}rotateX(e){return _i.makeRotationX(e),this.applyMatrix4(_i),this}rotateY(e){return _i.makeRotationY(e),this.applyMatrix4(_i),this}rotateZ(e){return _i.makeRotationZ(e),this.applyMatrix4(_i),this}translate(e,t,n){return _i.makeTranslation(e,t,n),this.applyMatrix4(_i),this}scale(e,t,n){return _i.makeScale(e,t,n),this.applyMatrix4(_i),this}lookAt(e){return Zd.lookAt(e),Zd.updateMatrix(),this.applyMatrix4(Zd.matrix),this}center(){return this.computeBoundingBox(),this.boundingBox.getCenter(So).negate(),this.translate(So.x,So.y,So.z),this}setFromPoints(e){let t=this.getAttribute("position");if(t===void 0){let n=[];for(let r=0,s=e.length;r<s;r++){let o=e[r];n.push(o.x,o.y,o.z||0)}this.setAttribute("position",new Ve(n,3))}else{let n=Math.min(e.length,t.count);for(let r=0;r<n;r++){let s=e[r];t.setXYZ(r,s.x,s.y,s.z||0)}e.length>t.count&&Ge("BufferGeometry: Buffer size too small for points data. Use .dispose() and create a new geometry."),t.needsUpdate=!0}return this}computeBoundingBox(){this.boundingBox===null&&(this.boundingBox=new cn);let e=this.attributes.position,t=this.morphAttributes.position;if(e&&e.isGLBufferAttribute){Qe("BufferGeometry.computeBoundingBox(): GLBufferAttribute requires a manual bounding box.",this),this.boundingBox.set(new R(-1/0,-1/0,-1/0),new R(1/0,1/0,1/0));return}if(e!==void 0){if(this.boundingBox.setFromBufferAttribute(e),t)for(let n=0,r=t.length;n<r;n++){let s=t[n];oi.setFromBufferAttribute(s),this.morphTargetsRelative?(fn.addVectors(this.boundingBox.min,oi.min),this.boundingBox.expandByPoint(fn),fn.addVectors(this.boundingBox.max,oi.max),this.boundingBox.expandByPoint(fn)):(this.boundingBox.expandByPoint(oi.min),this.boundingBox.expandByPoint(oi.max))}}else this.boundingBox.makeEmpty();(isNaN(this.boundingBox.min.x)||isNaN(this.boundingBox.min.y)||isNaN(this.boundingBox.min.z))&&Qe('BufferGeometry.computeBoundingBox(): Computed min/max have NaN values. The "position" attribute is likely to have NaN values.',this)}computeBoundingSphere(){this.boundingSphere===null&&(this.boundingSphere=new on);let e=this.attributes.position,t=this.morphAttributes.position;if(e&&e.isGLBufferAttribute){Qe("BufferGeometry.computeBoundingSphere(): GLBufferAttribute requires a manual bounding sphere.",this),this.boundingSphere.set(new R,1/0);return}if(e){let n=this.boundingSphere.center;if(oi.setFromBufferAttribute(e),t)for(let s=0,o=t.length;s<o;s++){let a=t[s];ja.setFromBufferAttribute(a),this.morphTargetsRelative?(fn.addVectors(oi.min,ja.min),oi.expandByPoint(fn),fn.addVectors(oi.max,ja.max),oi.expandByPoint(fn)):(oi.expandByPoint(ja.min),oi.expandByPoint(ja.max))}oi.getCenter(n);let r=0;for(let s=0,o=e.count;s<o;s++)fn.fromBufferAttribute(e,s),r=Math.max(r,n.distanceToSquared(fn));if(t)for(let s=0,o=t.length;s<o;s++){let a=t[s],l=this.morphTargetsRelative;for(let c=0,u=a.count;c<u;c++)fn.fromBufferAttribute(a,c),l&&(So.fromBufferAttribute(e,c),fn.add(So)),r=Math.max(r,n.distanceToSquared(fn))}this.boundingSphere.radius=Math.sqrt(r),isNaN(this.boundingSphere.radius)&&Qe('BufferGeometry.computeBoundingSphere(): Computed radius is NaN. The "position" attribute is likely to have NaN values.',this)}}computeTangents(){let e=this.index,t=this.attributes;if(e===null||t.position===void 0||t.normal===void 0||t.uv===void 0){Qe("BufferGeometry: .computeTangents() failed. Missing required attributes (index, position, normal or uv)");return}let n=t.position,r=t.normal,s=t.uv,o=this.getAttribute("tangent");(o===void 0||o.count!==n.count)&&(o=new ht(new Float32Array(4*n.count),4),this.setAttribute("tangent",o));let a=[],l=[];for(let M=0;M<n.count;M++)a[M]=new R,l[M]=new R;let c=new R,u=new R,f=new R,h=new he,d=new he,p=new he,v=new R,g=new R;function m(M,T,A){c.fromBufferAttribute(n,M),u.fromBufferAttribute(n,T),f.fromBufferAttribute(n,A),h.fromBufferAttribute(s,M),d.fromBufferAttribute(s,T),p.fromBufferAttribute(s,A),u.sub(c),f.sub(c),d.sub(h),p.sub(h);let I=1/(d.x*p.y-p.x*d.y);isFinite(I)&&(v.copy(u).multiplyScalar(p.y).addScaledVector(f,-d.y).multiplyScalar(I),g.copy(f).multiplyScalar(d.x).addScaledVector(u,-p.x).multiplyScalar(I),a[M].add(v),a[T].add(v),a[A].add(v),l[M].add(g),l[T].add(g),l[A].add(g))}let y=this.groups;y.length===0&&(y=[{start:0,count:e.count}]);for(let M=0,T=y.length;M<T;++M){let A=y[M],I=A.start,D=A.count;for(let B=I,F=I+D;B<F;B+=3)m(e.getX(B+0),e.getX(B+1),e.getX(B+2))}let _=new R,x=new R,S=new R,b=new R;function E(M){S.fromBufferAttribute(r,M),b.copy(S);let T=a[M];_.copy(T),_.sub(S.multiplyScalar(S.dot(T))).normalize(),x.crossVectors(b,T);let I=x.dot(l[M])<0?-1:1;o.setXYZW(M,_.x,_.y,_.z,I)}for(let M=0,T=y.length;M<T;++M){let A=y[M],I=A.start,D=A.count;for(let B=I,F=I+D;B<F;B+=3)E(e.getX(B+0)),E(e.getX(B+1)),E(e.getX(B+2))}this._transformed=!0}computeVertexNormals(){let e=this.index,t=this.getAttribute("position");if(t!==void 0){let n=this.getAttribute("normal");if(n===void 0||n.count!==t.count)n=new ht(new Float32Array(t.count*3),3),this.setAttribute("normal",n);else for(let h=0,d=n.count;h<d;h++)n.setXYZ(h,0,0,0);let r=new R,s=new R,o=new R,a=new R,l=new R,c=new R,u=new R,f=new R;if(e)for(let h=0,d=e.count;h<d;h+=3){let p=e.getX(h+0),v=e.getX(h+1),g=e.getX(h+2);r.fromBufferAttribute(t,p),s.fromBufferAttribute(t,v),o.fromBufferAttribute(t,g),u.subVectors(o,s),f.subVectors(r,s),u.cross(f),a.fromBufferAttribute(n,p),l.fromBufferAttribute(n,v),c.fromBufferAttribute(n,g),a.add(u),l.add(u),c.add(u),n.setXYZ(p,a.x,a.y,a.z),n.setXYZ(v,l.x,l.y,l.z),n.setXYZ(g,c.x,c.y,c.z)}else for(let h=0,d=t.count;h<d;h+=3)r.fromBufferAttribute(t,h+0),s.fromBufferAttribute(t,h+1),o.fromBufferAttribute(t,h+2),u.subVectors(o,s),f.subVectors(r,s),u.cross(f),n.setXYZ(h+0,u.x,u.y,u.z),n.setXYZ(h+1,u.x,u.y,u.z),n.setXYZ(h+2,u.x,u.y,u.z);this.normalizeNormals(),n.needsUpdate=!0}}normalizeNormals(){let e=this.attributes.normal;for(let t=0,n=e.count;t<n;t++)fn.fromBufferAttribute(e,t),fn.normalize(),e.setXYZ(t,fn.x,fn.y,fn.z)}toNonIndexed(){function e(a,l){let c=a.array,u=a.itemSize,f=a.normalized,h=new c.constructor(l.length*u),d=0,p=0;for(let v=0,g=l.length;v<g;v++){a.isInterleavedBufferAttribute?d=l[v]*a.data.stride+a.offset:d=l[v]*u;for(let m=0;m<u;m++)h[p++]=c[d++]}return new ht(h,u,f)}if(this.index===null)return Ge("BufferGeometry.toNonIndexed(): BufferGeometry is already non-indexed."),this;let t=new i,n=this.index.array,r=this.attributes;for(let a in r){let l=r[a],c=e(l,n);t.setAttribute(a,c)}let s=this.morphAttributes;for(let a in s){let l=[],c=s[a];for(let u=0,f=c.length;u<f;u++){let h=c[u],d=e(h,n);l.push(d)}t.morphAttributes[a]=l}t.morphTargetsRelative=this.morphTargetsRelative;let o=this.groups;for(let a=0,l=o.length;a<l;a++){let c=o[a];t.addGroup(c.start,c.count,c.materialIndex)}return t}toJSON(){let e={metadata:{version:4.7,type:"BufferGeometry",generator:"BufferGeometry.toJSON"}};if(e.uuid=this.uuid,e.type=this.parameters!==void 0&&this._transformed===!0?"BufferGeometry":this.type,e.name=this.name,Object.keys(this.userData).length>0&&(e.userData=this.userData),this.parameters!==void 0&&this._transformed!==!0){let l=this.parameters;for(let c in l)l[c]!==void 0&&(e[c]=l[c]);return e}e.data={attributes:{}};let t=this.index;t!==null&&(e.data.index={type:t.array.constructor.name,array:Array.prototype.slice.call(t.array)});let n=this.attributes;for(let l in n){let c=n[l];e.data.attributes[l]=c.toJSON(e.data)}let r={},s=!1;for(let l in this.morphAttributes){let c=this.morphAttributes[l],u=[];for(let f=0,h=c.length;f<h;f++){let d=c[f];u.push(d.toJSON(e.data))}u.length>0&&(r[l]=u,s=!0)}s&&(e.data.morphAttributes=r,e.data.morphTargetsRelative=this.morphTargetsRelative);let o=this.groups;o.length>0&&(e.data.groups=JSON.parse(JSON.stringify(o)));let a=this.boundingSphere;return a!==null&&(e.data.boundingSphere=a.toJSON()),e}clone(){return new this.constructor().copy(this)}copy(e){this.index=null,this.attributes={},this.morphAttributes={},this.groups=[],this.boundingBox=null,this.boundingSphere=null;let t={};this.name=e.name;let n=e.index;n!==null&&this.setIndex(n.clone());let r=e.attributes;for(let c in r){let u=r[c];this.setAttribute(c,u.clone(t))}let s=e.morphAttributes;for(let c in s){let u=[],f=s[c];for(let h=0,d=f.length;h<d;h++)u.push(f[h].clone(t));this.morphAttributes[c]=u}this.morphTargetsRelative=e.morphTargetsRelative;let o=e.groups;for(let c=0,u=o.length;c<u;c++){let f=o[c];this.addGroup(f.start,f.count,f.materialIndex)}let a=e.boundingBox;a!==null&&(this.boundingBox=a.clone());let l=e.boundingSphere;return l!==null&&(this.boundingSphere=l.clone()),this.drawRange.start=e.drawRange.start,this.drawRange.count=e.drawRange.count,this.userData=e.userData,this._transformed=e._transformed,this}dispose(){this.dispatchEvent({type:"dispose"})}},Jr=class{constructor(e,t){this.isInterleavedBuffer=!0,this.array=e,this.stride=t,this.count=e!==void 0?e.length/t:0,this.usage=js,this.updateRanges=[],this.version=0,this.uuid=ai()}onUploadCallback(){}set needsUpdate(e){e===!0&&this.version++}setUsage(e){return this.usage=e,this}addUpdateRange(e,t){this.updateRanges.push({start:e,count:t})}clearUpdateRanges(){this.updateRanges.length=0}copy(e){return this.array=new e.array.constructor(e.array),this.count=e.count,this.stride=e.stride,this.usage=e.usage,this}copyAt(e,t,n){e*=this.stride,n*=t.stride;for(let r=0,s=this.stride;r<s;r++)this.array[e+r]=t.array[n+r];return this}set(e,t=0){return this.array.set(e,t),this}clone(e){e.arrayBuffers===void 0&&(e.arrayBuffers={}),this.array.buffer._uuid===void 0&&(this.array.buffer._uuid=ai()),e.arrayBuffers[this.array.buffer._uuid]===void 0&&(e.arrayBuffers[this.array.buffer._uuid]=this.array.slice(0).buffer);let t=new this.array.constructor(e.arrayBuffers[this.array.buffer._uuid]),n=new this.constructor(t,this.stride);return n.setUsage(this.usage),n}onUpload(e){return this.onUploadCallback=e,this}toJSON(e){e.arrayBuffers===void 0&&(e.arrayBuffers={}),this.array.buffer._uuid===void 0&&(this.array.buffer._uuid=ai()),e.arrayBuffers[this.array.buffer._uuid]===void 0&&(e.arrayBuffers[this.array.buffer._uuid]=Array.from(new Uint32Array(this.array.buffer)));let t={uuid:this.uuid,buffer:this.array.buffer._uuid,type:this.array.constructor.name,stride:this.stride};return t.usage=this.usage,t}},Bn=new R,_r=class i{constructor(e,t,n,r=!1){this.isInterleavedBufferAttribute=!0,this.name="",this.data=e,this.itemSize=t,this.offset=n,this.normalized=r}get count(){return this.data.count}get array(){return this.data.array}set needsUpdate(e){this.data.needsUpdate=e}applyMatrix4(e){for(let t=0,n=this.data.count;t<n;t++)Bn.fromBufferAttribute(this,t),Bn.applyMatrix4(e),this.setXYZ(t,Bn.x,Bn.y,Bn.z);return this}applyNormalMatrix(e){for(let t=0,n=this.count;t<n;t++)Bn.fromBufferAttribute(this,t),Bn.applyNormalMatrix(e),this.setXYZ(t,Bn.x,Bn.y,Bn.z);return this}transformDirection(e){for(let t=0,n=this.count;t<n;t++)Bn.fromBufferAttribute(this,t),Bn.transformDirection(e),this.setXYZ(t,Bn.x,Bn.y,Bn.z);return this}getComponent(e,t){let n=this.array[e*this.data.stride+this.offset+t];return this.normalized&&(n=On(n,this.array)),n}setComponent(e,t,n){return this.normalized&&(n=mt(n,this.array)),this.data.array[e*this.data.stride+this.offset+t]=n,this}setX(e,t){return this.normalized&&(t=mt(t,this.array)),this.data.array[e*this.data.stride+this.offset]=t,this}setY(e,t){return this.normalized&&(t=mt(t,this.array)),this.data.array[e*this.data.stride+this.offset+1]=t,this}setZ(e,t){return this.normalized&&(t=mt(t,this.array)),this.data.array[e*this.data.stride+this.offset+2]=t,this}setW(e,t){return this.normalized&&(t=mt(t,this.array)),this.data.array[e*this.data.stride+this.offset+3]=t,this}getX(e){let t=this.data.array[e*this.data.stride+this.offset];return this.normalized&&(t=On(t,this.array)),t}getY(e){let t=this.data.array[e*this.data.stride+this.offset+1];return this.normalized&&(t=On(t,this.array)),t}getZ(e){let t=this.data.array[e*this.data.stride+this.offset+2];return this.normalized&&(t=On(t,this.array)),t}getW(e){let t=this.data.array[e*this.data.stride+this.offset+3];return this.normalized&&(t=On(t,this.array)),t}setXY(e,t,n){return e=e*this.data.stride+this.offset,this.normalized&&(t=mt(t,this.array),n=mt(n,this.array)),this.data.array[e+0]=t,this.data.array[e+1]=n,this}setXYZ(e,t,n,r){return e=e*this.data.stride+this.offset,this.normalized&&(t=mt(t,this.array),n=mt(n,this.array),r=mt(r,this.array)),this.data.array[e+0]=t,this.data.array[e+1]=n,this.data.array[e+2]=r,this}setXYZW(e,t,n,r,s){return e=e*this.data.stride+this.offset,this.normalized&&(t=mt(t,this.array),n=mt(n,this.array),r=mt(r,this.array),s=mt(s,this.array)),this.data.array[e+0]=t,this.data.array[e+1]=n,this.data.array[e+2]=r,this.data.array[e+3]=s,this}clone(e){if(e===void 0){Go("InterleavedBufferAttribute.clone(): Cloning an interleaved buffer attribute will de-interleave buffer data.");let t=[];for(let n=0;n<this.count;n++){let r=n*this.data.stride+this.offset;for(let s=0;s<this.itemSize;s++)t.push(this.data.array[r+s])}return new ht(new this.array.constructor(t),this.itemSize,this.normalized)}else return e.interleavedBuffers===void 0&&(e.interleavedBuffers={}),e.interleavedBuffers[this.data.uuid]===void 0&&(e.interleavedBuffers[this.data.uuid]=this.data.clone(e)),new i(e.interleavedBuffers[this.data.uuid],this.itemSize,this.offset,this.normalized)}toJSON(e){if(e===void 0){Go("InterleavedBufferAttribute.toJSON(): Serializing an interleaved buffer attribute will de-interleave buffer data.");let t=[];for(let n=0;n<this.count;n++){let r=n*this.data.stride+this.offset;for(let s=0;s<this.itemSize;s++)t.push(this.data.array[r+s])}return{itemSize:this.itemSize,type:this.array.constructor.name,array:t,normalized:this.normalized}}else return e.interleavedBuffers===void 0&&(e.interleavedBuffers={}),e.interleavedBuffers[this.data.uuid]===void 0&&(e.interleavedBuffers[this.data.uuid]=this.data.toJSON(e)),{isInterleavedBufferAttribute:!0,itemSize:this.itemSize,data:this.data.uuid,offset:this.offset,normalized:this.normalized}}},$d=new R,h_=new R,f_=new ft,Mi=class{constructor(e=new R(1,0,0),t=0){this.isPlane=!0,this.normal=e,this.constant=t}set(e,t){return this.normal.copy(e),this.constant=t,this}setComponents(e,t,n,r){return this.normal.set(e,t,n),this.constant=r,this}setFromNormalAndCoplanarPoint(e,t){return this.normal.copy(e),this.constant=-t.dot(this.normal),this}setFromCoplanarPoints(e,t,n){let r=$d.subVectors(n,t).cross(h_.subVectors(e,t)).normalize();return this.setFromNormalAndCoplanarPoint(r,e),this}copy(e){return this.normal.copy(e.normal),this.constant=e.constant,this}normalize(){let e=1/this.normal.length();return this.normal.multiplyScalar(e),this.constant*=e,this}negate(){return this.constant*=-1,this.normal.negate(),this}distanceToPoint(e){return this.normal.dot(e)+this.constant}distanceToSphere(e){return this.distanceToPoint(e.center)-e.radius}projectPoint(e,t){return t.copy(e).addScaledVector(this.normal,-this.distanceToPoint(e))}intersectLine(e,t,n=!0){let r=e.delta($d),s=this.normal.dot(r);if(s===0)return this.distanceToPoint(e.start)===0?t.copy(e.start):null;let o=-(e.start.dot(this.normal)+this.constant)/s;return n===!0&&(o<0||o>1)?null:t.copy(e.start).addScaledVector(r,o)}intersectsLine(e){let t=this.distanceToPoint(e.start),n=this.distanceToPoint(e.end);return t<0&&n>0||n<0&&t>0}intersectsBox(e){return e.intersectsPlane(this)}intersectsSphere(e){return e.intersectsPlane(this)}coplanarPoint(e){return e.copy(this.normal).multiplyScalar(-this.constant)}applyMatrix4(e,t){let n=t||f_.getNormalMatrix(e),r=this.coplanarPoint($d).applyMatrix4(e),s=this.normal.applyMatrix3(n).normalize();return this.constant=-r.dot(s),this}translate(e){return this.constant-=e.dot(this.normal),this}equals(e){return e.normal.equals(this.normal)&&e.constant===this.constant}clone(){return new this.constructor().copy(this)}toJSON(){return{normal:this.normal.toArray(),constant:this.constant}}fromJSON(e){return this.normal.fromArray(e.normal),this.constant=e.constant,this}},d_=0,an=class extends jn{constructor(){super(),this.isMaterial=!0,Object.defineProperty(this,"id",{value:d_++}),this.uuid=ai(),this.name="",this.type="Material",this.blending=Ys,this.side=Er,this.vertexColors=!1,this.opacity=1,this.transparent=!1,this.alphaHash=!1,this.blendSrc=Of,this.blendDst=zf,this.blendEquation=is,this.blendSrcAlpha=null,this.blendDstAlpha=null,this.blendEquationAlpha=null,this.blendColor=new be(0,0,0),this.blendAlpha=0,this.depthFunc=ws,this.depthTest=!0,this.depthWrite=!0,this.stencilWriteMask=255,this.stencilFunc=om,this.stencilRef=0,this.stencilFuncMask=255,this.stencilFail=ul,this.stencilZFail=ul,this.stencilZPass=ul,this.stencilWrite=!1,this.clippingPlanes=null,this.clipIntersection=!1,this.clipShadows=!1,this.shadowSide=null,this.colorWrite=!0,this.precision=null,this.polygonOffset=!1,this.polygonOffsetFactor=0,this.polygonOffsetUnits=0,this.dithering=!1,this.alphaToCoverage=!1,this.premultipliedAlpha=!1,this.forceSinglePass=!1,this.allowOverride=!0,this.visible=!0,this.toneMapped=!0,this.userData={},this.version=0,this._alphaTest=0}get alphaTest(){return this._alphaTest}set alphaTest(e){this._alphaTest>0!=e>0&&this.version++,this._alphaTest=e}onBeforeRender(){}onBeforeCompile(){}customProgramCacheKey(){return this.onBeforeCompile.toString()}setValues(e){if(e!==void 0)for(let t in e){let n=e[t];if(n===void 0){Ge(`Material: parameter '${t}' has value of undefined.`);continue}let r=this[t];if(r===void 0){Ge(`Material: '${t}' is not a property of THREE.${this.type}.`);continue}r&&r.isColor?r.set(n):r&&r.isVector2&&n&&n.isVector2||r&&r.isEuler&&n&&n.isEuler||r&&r.isVector3&&n&&n.isVector3?r.copy(n):this[t]=n}}toJSON(e){let t=e===void 0||typeof e=="string";t&&(e={textures:{},images:{}});let n={metadata:{version:4.7,type:"Material",generator:"Material.toJSON"}};n.uuid=this.uuid,n.type=this.type,n.blending=this.blending,n.side=this.side,n.shadowSide=this.shadowSide,n.vertexColors=this.vertexColors,n.opacity=this.opacity,n.transparent=this.transparent,n.blendSrc=this.blendSrc,n.blendDst=this.blendDst,n.blendEquation=this.blendEquation,n.blendSrcAlpha=this.blendSrcAlpha,n.blendDstAlpha=this.blendDstAlpha,n.blendEquationAlpha=this.blendEquationAlpha,n.blendColor=this.blendColor.getHex(),n.blendAlpha=this.blendAlpha,n.depthFunc=this.depthFunc,n.depthTest=this.depthTest,n.depthWrite=this.depthWrite,n.colorWrite=this.colorWrite,n.clipIntersection=this.clipIntersection,n.clipShadows=this.clipShadows,n.stencilWriteMask=this.stencilWriteMask,n.stencilFunc=this.stencilFunc,n.stencilRef=this.stencilRef,n.stencilFuncMask=this.stencilFuncMask,n.stencilFail=this.stencilFail,n.stencilZFail=this.stencilZFail,n.stencilZPass=this.stencilZPass,n.stencilWrite=this.stencilWrite,n.polygonOffset=this.polygonOffset,n.polygonOffsetFactor=this.polygonOffsetFactor,n.polygonOffsetUnits=this.polygonOffsetUnits,n.dithering=this.dithering,n.alphaTest=this.alphaTest,n.alphaHash=this.alphaHash,n.alphaToCoverage=this.alphaToCoverage,n.premultipliedAlpha=this.premultipliedAlpha,n.forceSinglePass=this.forceSinglePass,n.allowOverride=this.allowOverride,n.visible=this.visible,n.toneMapped=this.toneMapped,n.name=this.name,this.color&&this.color.isColor&&(n.color=this.color.getHex()),this.roughness!==void 0&&(n.roughness=this.roughness),this.metalness!==void 0&&(n.metalness=this.metalness),this.sheen!==void 0&&(n.sheen=this.sheen),this.sheenColor&&this.sheenColor.isColor&&(n.sheenColor=this.sheenColor.getHex()),this.sheenRoughness!==void 0&&(n.sheenRoughness=this.sheenRoughness),this.emissive&&this.emissive.isColor&&(n.emissive=this.emissive.getHex()),this.emissiveIntensity!==void 0&&(n.emissiveIntensity=this.emissiveIntensity),this.specular&&this.specular.isColor&&(n.specular=this.specular.getHex()),this.specularIntensity!==void 0&&(n.specularIntensity=this.specularIntensity),this.specularColor&&this.specularColor.isColor&&(n.specularColor=this.specularColor.getHex()),this.shininess!==void 0&&(n.shininess=this.shininess),this.clearcoat!==void 0&&(n.clearcoat=this.clearcoat),this.clearcoatRoughness!==void 0&&(n.clearcoatRoughness=this.clearcoatRoughness),this.clearcoatMap&&this.clearcoatMap.isTexture&&(n.clearcoatMap=this.clearcoatMap.toJSON(e).uuid),this.clearcoatRoughnessMap&&this.clearcoatRoughnessMap.isTexture&&(n.clearcoatRoughnessMap=this.clearcoatRoughnessMap.toJSON(e).uuid),this.clearcoatNormalMap&&this.clearcoatNormalMap.isTexture&&(n.clearcoatNormalMap=this.clearcoatNormalMap.toJSON(e).uuid,n.clearcoatNormalScale=this.clearcoatNormalScale.toArray()),this.sheenColorMap&&this.sheenColorMap.isTexture&&(n.sheenColorMap=this.sheenColorMap.toJSON(e).uuid),this.sheenRoughnessMap&&this.sheenRoughnessMap.isTexture&&(n.sheenRoughnessMap=this.sheenRoughnessMap.toJSON(e).uuid),this.dispersion!==void 0&&(n.dispersion=this.dispersion),this.retroreflectivity!==void 0&&(n.retroreflectivity=this.retroreflectivity),this.iridescence!==void 0&&(n.iridescence=this.iridescence),this.iridescenceIOR!==void 0&&(n.iridescenceIOR=this.iridescenceIOR),this.iridescenceThicknessRange!==void 0&&(n.iridescenceThicknessRange=this.iridescenceThicknessRange),this.iridescenceMap&&this.iridescenceMap.isTexture&&(n.iridescenceMap=this.iridescenceMap.toJSON(e).uuid),this.iridescenceThicknessMap&&this.iridescenceThicknessMap.isTexture&&(n.iridescenceThicknessMap=this.iridescenceThicknessMap.toJSON(e).uuid),this.anisotropy!==void 0&&(n.anisotropy=this.anisotropy),this.anisotropyRotation!==void 0&&(n.anisotropyRotation=this.anisotropyRotation),this.anisotropyMap&&this.anisotropyMap.isTexture&&(n.anisotropyMap=this.anisotropyMap.toJSON(e).uuid),this.map&&this.map.isTexture&&(n.map=this.map.toJSON(e).uuid),this.matcap&&this.matcap.isTexture&&(n.matcap=this.matcap.toJSON(e).uuid),this.alphaMap&&this.alphaMap.isTexture&&(n.alphaMap=this.alphaMap.toJSON(e).uuid),this.lightMap&&this.lightMap.isTexture&&(n.lightMap=this.lightMap.toJSON(e).uuid,n.lightMapIntensity=this.lightMapIntensity),this.aoMap&&this.aoMap.isTexture&&(n.aoMap=this.aoMap.toJSON(e).uuid,n.aoMapIntensity=this.aoMapIntensity),this.bumpMap&&this.bumpMap.isTexture&&(n.bumpMap=this.bumpMap.toJSON(e).uuid,n.bumpScale=this.bumpScale),this.normalMap&&this.normalMap.isTexture&&(n.normalMap=this.normalMap.toJSON(e).uuid,n.normalMapType=this.normalMapType,n.normalScale=this.normalScale.toArray()),this.displacementMap&&this.displacementMap.isTexture&&(n.displacementMap=this.displacementMap.toJSON(e).uuid,n.displacementScale=this.displacementScale,n.displacementBias=this.displacementBias),this.roughnessMap&&this.roughnessMap.isTexture&&(n.roughnessMap=this.roughnessMap.toJSON(e).uuid),this.metalnessMap&&this.metalnessMap.isTexture&&(n.metalnessMap=this.metalnessMap.toJSON(e).uuid),this.emissiveMap&&this.emissiveMap.isTexture&&(n.emissiveMap=this.emissiveMap.toJSON(e).uuid),this.specularMap&&this.specularMap.isTexture&&(n.specularMap=this.specularMap.toJSON(e).uuid),this.specularIntensityMap&&this.specularIntensityMap.isTexture&&(n.specularIntensityMap=this.specularIntensityMap.toJSON(e).uuid),this.specularColorMap&&this.specularColorMap.isTexture&&(n.specularColorMap=this.specularColorMap.toJSON(e).uuid),this.envMap&&this.envMap.isTexture&&(n.envMap=this.envMap.toJSON(e).uuid,this.combine!==void 0&&(n.combine=this.combine)),this.envMapRotation!==void 0&&(n.envMapRotation=this.envMapRotation.toArray()),this.envMapIntensity!==void 0&&(n.envMapIntensity=this.envMapIntensity),this.reflectivity!==void 0&&(n.reflectivity=this.reflectivity),this.refractionRatio!==void 0&&(n.refractionRatio=this.refractionRatio),this.gradientMap&&this.gradientMap.isTexture&&(n.gradientMap=this.gradientMap.toJSON(e).uuid),this.transmission!==void 0&&(n.transmission=this.transmission),this.transmissionMap&&this.transmissionMap.isTexture&&(n.transmissionMap=this.transmissionMap.toJSON(e).uuid),this.thickness!==void 0&&(n.thickness=this.thickness),this.thicknessMap&&this.thicknessMap.isTexture&&(n.thicknessMap=this.thicknessMap.toJSON(e).uuid),this.attenuationDistance!==void 0&&(n.attenuationDistance=this.attenuationDistance),this.attenuationColor!==void 0&&(n.attenuationColor=this.attenuationColor.getHex()),this.size!==void 0&&(n.size=this.size),this.sizeAttenuation!==void 0&&(n.sizeAttenuation=this.sizeAttenuation),Array.isArray(this.clippingPlanes)&&this.clippingPlanes.length>0&&(n.clippingPlanes=this.clippingPlanes.map(s=>s.toJSON())),this.rotation!==void 0&&(n.rotation=this.rotation),this.depthPacking!==void 0&&(n.depthPacking=this.depthPacking),this.linewidth!==void 0&&(n.linewidth=this.linewidth),this.linecap!==void 0&&(n.linecap=this.linecap),this.linejoin!==void 0&&(n.linejoin=this.linejoin),this.dashSize!==void 0&&(n.dashSize=this.dashSize),this.gapSize!==void 0&&(n.gapSize=this.gapSize),this.scale!==void 0&&(n.scale=this.scale),this.wireframe!==void 0&&(n.wireframe=this.wireframe),this.wireframeLinewidth!==void 0&&(n.wireframeLinewidth=this.wireframeLinewidth),this.wireframeLinecap!==void 0&&(n.wireframeLinecap=this.wireframeLinecap),this.wireframeLinejoin!==void 0&&(n.wireframeLinejoin=this.wireframeLinejoin),this.flatShading!==void 0&&(n.flatShading=this.flatShading),this.fog!==void 0&&(n.fog=this.fog),Object.keys(this.userData).length>0&&(n.userData=this.userData);function r(s){let o=[];for(let a in s){let l=s[a];delete l.metadata,o.push(l)}return o}if(t){let s=r(e.textures),o=r(e.images);s.length>0&&(n.textures=s),o.length>0&&(n.images=o)}return n}fromJSON(e,t){if(e.uuid!==void 0&&(this.uuid=e.uuid),e.name!==void 0&&(this.name=e.name),e.color!==void 0&&this.color!==void 0&&this.color.setHex(e.color),e.roughness!==void 0&&(this.roughness=e.roughness),e.metalness!==void 0&&(this.metalness=e.metalness),e.sheen!==void 0&&(this.sheen=e.sheen),e.sheenColor!==void 0&&(this.sheenColor=new be().setHex(e.sheenColor)),e.sheenRoughness!==void 0&&(this.sheenRoughness=e.sheenRoughness),e.emissive!==void 0&&this.emissive!==void 0&&this.emissive.setHex(e.emissive),e.specular!==void 0&&this.specular!==void 0&&this.specular.setHex(e.specular),e.specularIntensity!==void 0&&(this.specularIntensity=e.specularIntensity),e.specularColor!==void 0&&this.specularColor!==void 0&&this.specularColor.setHex(e.specularColor),e.shininess!==void 0&&(this.shininess=e.shininess),e.clearcoat!==void 0&&(this.clearcoat=e.clearcoat),e.clearcoatRoughness!==void 0&&(this.clearcoatRoughness=e.clearcoatRoughness),e.dispersion!==void 0&&(this.dispersion=e.dispersion),e.retroreflectivity!==void 0&&(this.retroreflectivity=e.retroreflectivity),e.iridescence!==void 0&&(this.iridescence=e.iridescence),e.iridescenceIOR!==void 0&&(this.iridescenceIOR=e.iridescenceIOR),e.iridescenceThicknessRange!==void 0&&(this.iridescenceThicknessRange=e.iridescenceThicknessRange),e.transmission!==void 0&&(this.transmission=e.transmission),e.thickness!==void 0&&(this.thickness=e.thickness),e.attenuationDistance!==void 0&&(this.attenuationDistance=e.attenuationDistance),e.attenuationColor!==void 0&&this.attenuationColor!==void 0&&this.attenuationColor.setHex(e.attenuationColor),e.anisotropy!==void 0&&(this.anisotropy=e.anisotropy),e.anisotropyRotation!==void 0&&(this.anisotropyRotation=e.anisotropyRotation),e.fog!==void 0&&(this.fog=e.fog),e.flatShading!==void 0&&(this.flatShading=e.flatShading),e.blending!==void 0&&(this.blending=e.blending),e.combine!==void 0&&(this.combine=e.combine),e.side!==void 0&&(this.side=e.side),e.shadowSide!==void 0&&(this.shadowSide=e.shadowSide),e.opacity!==void 0&&(this.opacity=e.opacity),e.transparent!==void 0&&(this.transparent=e.transparent),e.alphaTest!==void 0&&(this.alphaTest=e.alphaTest),e.alphaHash!==void 0&&(this.alphaHash=e.alphaHash),e.depthFunc!==void 0&&(this.depthFunc=e.depthFunc),e.depthTest!==void 0&&(this.depthTest=e.depthTest),e.depthWrite!==void 0&&(this.depthWrite=e.depthWrite),e.colorWrite!==void 0&&(this.colorWrite=e.colorWrite),e.clippingPlanes!==void 0&&(this.clippingPlanes=e.clippingPlanes.map(n=>new Mi().fromJSON(n))),e.clipIntersection!==void 0&&(this.clipIntersection=e.clipIntersection),e.clipShadows!==void 0&&(this.clipShadows=e.clipShadows),e.depthPacking!==void 0&&(this.depthPacking=e.depthPacking),e.blendSrc!==void 0&&(this.blendSrc=e.blendSrc),e.blendDst!==void 0&&(this.blendDst=e.blendDst),e.blendEquation!==void 0&&(this.blendEquation=e.blendEquation),e.blendSrcAlpha!==void 0&&(this.blendSrcAlpha=e.blendSrcAlpha),e.blendDstAlpha!==void 0&&(this.blendDstAlpha=e.blendDstAlpha),e.blendEquationAlpha!==void 0&&(this.blendEquationAlpha=e.blendEquationAlpha),e.blendColor!==void 0&&this.blendColor!==void 0&&this.blendColor.setHex(e.blendColor),e.blendAlpha!==void 0&&(this.blendAlpha=e.blendAlpha),e.stencilWriteMask!==void 0&&(this.stencilWriteMask=e.stencilWriteMask),e.stencilFunc!==void 0&&(this.stencilFunc=e.stencilFunc),e.stencilRef!==void 0&&(this.stencilRef=e.stencilRef),e.stencilFuncMask!==void 0&&(this.stencilFuncMask=e.stencilFuncMask),e.stencilFail!==void 0&&(this.stencilFail=e.stencilFail),e.stencilZFail!==void 0&&(this.stencilZFail=e.stencilZFail),e.stencilZPass!==void 0&&(this.stencilZPass=e.stencilZPass),e.stencilWrite!==void 0&&(this.stencilWrite=e.stencilWrite),e.wireframe!==void 0&&(this.wireframe=e.wireframe),e.wireframeLinewidth!==void 0&&(this.wireframeLinewidth=e.wireframeLinewidth),e.wireframeLinecap!==void 0&&(this.wireframeLinecap=e.wireframeLinecap),e.wireframeLinejoin!==void 0&&(this.wireframeLinejoin=e.wireframeLinejoin),e.rotation!==void 0&&(this.rotation=e.rotation),e.linewidth!==void 0&&(this.linewidth=e.linewidth),e.linecap!==void 0&&(this.linecap=e.linecap),e.linejoin!==void 0&&(this.linejoin=e.linejoin),e.dashSize!==void 0&&(this.dashSize=e.dashSize),e.gapSize!==void 0&&(this.gapSize=e.gapSize),e.scale!==void 0&&(this.scale=e.scale),e.polygonOffset!==void 0&&(this.polygonOffset=e.polygonOffset),e.polygonOffsetFactor!==void 0&&(this.polygonOffsetFactor=e.polygonOffsetFactor),e.polygonOffsetUnits!==void 0&&(this.polygonOffsetUnits=e.polygonOffsetUnits),e.dithering!==void 0&&(this.dithering=e.dithering),e.alphaToCoverage!==void 0&&(this.alphaToCoverage=e.alphaToCoverage),e.premultipliedAlpha!==void 0&&(this.premultipliedAlpha=e.premultipliedAlpha),e.forceSinglePass!==void 0&&(this.forceSinglePass=e.forceSinglePass),e.allowOverride!==void 0&&(this.allowOverride=e.allowOverride),e.visible!==void 0&&(this.visible=e.visible),e.toneMapped!==void 0&&(this.toneMapped=e.toneMapped),e.userData!==void 0&&(this.userData=e.userData),e.vertexColors!==void 0&&(typeof e.vertexColors=="number"?this.vertexColors=e.vertexColors>0:this.vertexColors=e.vertexColors),e.size!==void 0&&(this.size=e.size),e.sizeAttenuation!==void 0&&(this.sizeAttenuation=e.sizeAttenuation),e.map!==void 0&&(this.map=t[e.map]||null),e.matcap!==void 0&&(this.matcap=t[e.matcap]||null),e.alphaMap!==void 0&&(this.alphaMap=t[e.alphaMap]||null),e.bumpMap!==void 0&&(this.bumpMap=t[e.bumpMap]||null),e.bumpScale!==void 0&&(this.bumpScale=e.bumpScale),e.normalMap!==void 0&&(this.normalMap=t[e.normalMap]||null),e.normalMapType!==void 0&&(this.normalMapType=e.normalMapType),e.normalScale!==void 0){let n=e.normalScale;Array.isArray(n)===!1&&(n=[n,n]),this.normalScale=new he().fromArray(n)}return e.displacementMap!==void 0&&(this.displacementMap=t[e.displacementMap]||null),e.displacementScale!==void 0&&(this.displacementScale=e.displacementScale),e.displacementBias!==void 0&&(this.displacementBias=e.displacementBias),e.roughnessMap!==void 0&&(this.roughnessMap=t[e.roughnessMap]||null),e.metalnessMap!==void 0&&(this.metalnessMap=t[e.metalnessMap]||null),e.emissiveMap!==void 0&&(this.emissiveMap=t[e.emissiveMap]||null),e.emissiveIntensity!==void 0&&(this.emissiveIntensity=e.emissiveIntensity),e.specularMap!==void 0&&(this.specularMap=t[e.specularMap]||null),e.specularIntensityMap!==void 0&&(this.specularIntensityMap=t[e.specularIntensityMap]||null),e.specularColorMap!==void 0&&(this.specularColorMap=t[e.specularColorMap]||null),e.envMap!==void 0&&(this.envMap=t[e.envMap]||null),e.envMapRotation!==void 0&&this.envMapRotation.fromArray(e.envMapRotation),e.envMapIntensity!==void 0&&(this.envMapIntensity=e.envMapIntensity),e.reflectivity!==void 0&&(this.reflectivity=e.reflectivity),e.refractionRatio!==void 0&&(this.refractionRatio=e.refractionRatio),e.lightMap!==void 0&&(this.lightMap=t[e.lightMap]||null),e.lightMapIntensity!==void 0&&(this.lightMapIntensity=e.lightMapIntensity),e.aoMap!==void 0&&(this.aoMap=t[e.aoMap]||null),e.aoMapIntensity!==void 0&&(this.aoMapIntensity=e.aoMapIntensity),e.gradientMap!==void 0&&(this.gradientMap=t[e.gradientMap]||null),e.clearcoatMap!==void 0&&(this.clearcoatMap=t[e.clearcoatMap]||null),e.clearcoatRoughnessMap!==void 0&&(this.clearcoatRoughnessMap=t[e.clearcoatRoughnessMap]||null),e.clearcoatNormalMap!==void 0&&(this.clearcoatNormalMap=t[e.clearcoatNormalMap]||null),e.clearcoatNormalScale!==void 0&&(this.clearcoatNormalScale=new he().fromArray(e.clearcoatNormalScale)),e.iridescenceMap!==void 0&&(this.iridescenceMap=t[e.iridescenceMap]||null),e.iridescenceThicknessMap!==void 0&&(this.iridescenceThicknessMap=t[e.iridescenceThicknessMap]||null),e.transmissionMap!==void 0&&(this.transmissionMap=t[e.transmissionMap]||null),e.thicknessMap!==void 0&&(this.thicknessMap=t[e.thicknessMap]||null),e.anisotropyMap!==void 0&&(this.anisotropyMap=t[e.anisotropyMap]||null),e.sheenColorMap!==void 0&&(this.sheenColorMap=t[e.sheenColorMap]||null),e.sheenRoughnessMap!==void 0&&(this.sheenRoughnessMap=t[e.sheenRoughnessMap]||null),this}clone(){return new this.constructor().copy(this)}copy(e){this.name=e.name,this.blending=e.blending,this.side=e.side,this.vertexColors=e.vertexColors,this.opacity=e.opacity,this.transparent=e.transparent,this.blendSrc=e.blendSrc,this.blendDst=e.blendDst,this.blendEquation=e.blendEquation,this.blendSrcAlpha=e.blendSrcAlpha,this.blendDstAlpha=e.blendDstAlpha,this.blendEquationAlpha=e.blendEquationAlpha,this.blendColor.copy(e.blendColor),this.blendAlpha=e.blendAlpha,this.depthFunc=e.depthFunc,this.depthTest=e.depthTest,this.depthWrite=e.depthWrite,this.stencilWriteMask=e.stencilWriteMask,this.stencilFunc=e.stencilFunc,this.stencilRef=e.stencilRef,this.stencilFuncMask=e.stencilFuncMask,this.stencilFail=e.stencilFail,this.stencilZFail=e.stencilZFail,this.stencilZPass=e.stencilZPass,this.stencilWrite=e.stencilWrite;let t=e.clippingPlanes,n=null;if(t!==null){let r=t.length;n=new Array(r);for(let s=0;s!==r;++s)n[s]=t[s].clone()}return this.clippingPlanes=n,this.clipIntersection=e.clipIntersection,this.clipShadows=e.clipShadows,this.shadowSide=e.shadowSide,this.colorWrite=e.colorWrite,this.precision=e.precision,this.polygonOffset=e.polygonOffset,this.polygonOffsetFactor=e.polygonOffsetFactor,this.polygonOffsetUnits=e.polygonOffsetUnits,this.dithering=e.dithering,this.alphaTest=e.alphaTest,this.alphaHash=e.alphaHash,this.alphaToCoverage=e.alphaToCoverage,this.premultipliedAlpha=e.premultipliedAlpha,this.forceSinglePass=e.forceSinglePass,this.allowOverride=e.allowOverride,this.visible=e.visible,this.toneMapped=e.toneMapped,this.userData=JSON.parse(JSON.stringify(e.userData)),this}dispose(){this.dispatchEvent({type:"dispose"})}set needsUpdate(e){e===!0&&this.version++}},Xo=class extends an{constructor(e){super(),this.isSpriteMaterial=!0,this.type="SpriteMaterial",this.color=new be(16777215),this.map=null,this.alphaMap=null,this.rotation=0,this.sizeAttenuation=!0,this.transparent=!0,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.alphaMap=e.alphaMap,this.rotation=e.rotation,this.sizeAttenuation=e.sizeAttenuation,this.fog=e.fog,this}},bo,Qa=new R,wo=new R,To=new R,Ao=new he,el=new he,Pv=new it,Hu=new R,tl=new R,Wu=new R,U0=new he,Jd=new he,B0=new he,Tl=class extends At{constructor(e=new Xo){if(super(),this.isSprite=!0,this.type="Sprite",bo===void 0){bo=new et;let t=new Float32Array([-.5,-.5,0,0,0,.5,-.5,0,1,0,.5,.5,0,1,1,-.5,.5,0,0,1]),n=new Jr(t,5);bo.setIndex([0,1,2,0,2,3]),bo.setAttribute("position",new _r(n,3,0,!1)),bo.setAttribute("uv",new _r(n,2,3,!1))}this.geometry=bo,this.material=e,this.center=new he(.5,.5),this.count=1}intersectsFrustum(e){return e.intersectsSprite(this)}raycast(e,t){e.camera===null&&Qe('Sprite: "Raycaster.camera" needs to be set in order to raycast against sprites.'),wo.setFromMatrixScale(this.matrixWorld),Pv.copy(e.camera.matrixWorld),this.modelViewMatrix.multiplyMatrices(e.camera.matrixWorldInverse,this.matrixWorld),To.setFromMatrixPosition(this.modelViewMatrix),e.camera.isPerspectiveCamera&&this.material.sizeAttenuation===!1&&wo.multiplyScalar(-To.z);let n=this.material.rotation,r,s;n!==0&&(s=Math.cos(n),r=Math.sin(n));let o=this.center;Xu(Hu.set(-.5,-.5,0),To,o,wo,r,s),Xu(tl.set(.5,-.5,0),To,o,wo,r,s),Xu(Wu.set(.5,.5,0),To,o,wo,r,s),U0.set(0,0),Jd.set(1,0),B0.set(1,1);let a=e.ray.intersectTriangle(Hu,tl,Wu,!1,Qa);if(a===null&&(Xu(tl.set(-.5,.5,0),To,o,wo,r,s),Jd.set(0,1),a=e.ray.intersectTriangle(Hu,Wu,tl,!1,Qa),a===null))return;let l=e.ray.origin.distanceTo(Qa);l<e.near||l>e.far||t.push({distance:l,point:Qa.clone(),uv:Ni.getInterpolation(Qa,Hu,tl,Wu,U0,Jd,B0,new he),face:null,object:this})}copy(e,t){return super.copy(e,t),e.center!==void 0&&this.center.copy(e.center),this.material=e.material,this}};function Xu(i,e,t,n,r,s){Ao.subVectors(i,t).addScalar(.5).multiply(n),r!==void 0?(el.x=s*Ao.x-r*Ao.y,el.y=r*Ao.x+s*Ao.y):el.copy(Ao),i.copy(e),i.x+=el.x,i.y+=el.y,i.applyMatrix4(Pv)}var qu=new R,O0=new R,Al=class extends At{constructor(){super(),this.isLOD=!0,this._currentLevel=0,this.type="LOD",Object.defineProperties(this,{levels:{enumerable:!0,value:[]}}),this.autoUpdate=!0}copy(e){super.copy(e,!1);let t=e.levels;for(let n=0,r=t.length;n<r;n++){let s=t[n];this.addLevel(s.object.clone(),s.distance,s.hysteresis)}return this.autoUpdate=e.autoUpdate,this}addLevel(e,t=0,n=0){t=Math.abs(t);let r=this.levels,s;for(s=0;s<r.length&&!(t<r[s].distance);s++);return r.splice(s,0,{distance:t,hysteresis:n,object:e}),this.add(e),this}removeLevel(e){let t=this.levels;for(let n=0;n<t.length;n++)if(t[n].distance===e){let r=t.splice(n,1);return this.remove(r[0].object),!0}return!1}getCurrentLevel(){return this._currentLevel}getObjectForDistance(e){let t=this.levels;if(t.length>0){let n,r;for(n=1,r=t.length;n<r;n++){let s=t[n].distance;if(t[n].object.visible&&(s-=s*t[n].hysteresis),e<s)break}return t[n-1].object}return null}raycast(e,t){if(this.levels.length>0){qu.setFromMatrixPosition(this.matrixWorld);let r=e.ray.origin.distanceTo(qu);this.getObjectForDistance(r).raycast(e,t)}}update(e){let t=this.levels;if(t.length>1){qu.setFromMatrixPosition(e.matrixWorld),O0.setFromMatrixPosition(this.matrixWorld);let n=qu.distanceTo(O0)/e.zoom;t[0].object.visible=!0;let r,s;for(r=1,s=t.length;r<s;r++){let o=t[r].distance;if(t[r].object.visible&&(o-=o*t[r].hysteresis),n>=o)t[r-1].object.visible=!1,t[r].object.visible=!0;else break}for(this._currentLevel=r-1;r<s;r++)t[r].object.visible=!1}}toJSON(e){let t=super.toJSON(e);t.object.autoUpdate=this.autoUpdate,t.object.levels=[];let n=this.levels;for(let r=0,s=n.length;r<s;r++){let o=n[r];t.object.levels.push({object:o.object.uuid,distance:o.distance,hysteresis:o.hysteresis})}return t}},gr=new R,Kd=new R,Yu=new R,Zu=new R,Mr=class{constructor(e=new R,t=new R(0,0,-1)){this.origin=e,this.direction=t}set(e,t){return this.origin.copy(e),this.direction.copy(t),this}copy(e){return this.origin.copy(e.origin),this.direction.copy(e.direction),this}at(e,t){return t.copy(this.origin).addScaledVector(this.direction,e)}lookAt(e){return this.direction.copy(e).sub(this.origin).normalize(),this}recast(e){return this.origin.copy(this.at(e,gr)),this}closestPointToPoint(e,t){t.subVectors(e,this.origin);let n=t.dot(this.direction);return n<0?t.copy(this.origin):t.copy(this.origin).addScaledVector(this.direction,n)}distanceToPoint(e){return Math.sqrt(this.distanceSqToPoint(e))}distanceSqToPoint(e){let t=gr.subVectors(e,this.origin).dot(this.direction);return t<0?this.origin.distanceToSquared(e):(gr.copy(this.origin).addScaledVector(this.direction,t),gr.distanceToSquared(e))}distanceSqToSegment(e,t,n,r){Kd.copy(e).add(t).multiplyScalar(.5),Yu.copy(t).sub(e).normalize(),Zu.copy(this.origin).sub(Kd);let s=e.distanceTo(t)*.5,o=-this.direction.dot(Yu),a=Zu.dot(this.direction),l=-Zu.dot(Yu),c=Zu.lengthSq(),u=Math.abs(1-o*o),f,h,d,p;if(u>0)if(f=o*l-a,h=o*a-l,p=s*u,f>=0)if(h>=-p)if(h<=p){let v=1/u;f*=v,h*=v,d=f*(f+o*h+2*a)+h*(o*f+h+2*l)+c}else h=s,f=Math.max(0,-(o*h+a)),d=-f*f+h*(h+2*l)+c;else h=-s,f=Math.max(0,-(o*h+a)),d=-f*f+h*(h+2*l)+c;else h<=-p?(f=Math.max(0,-(-o*s+a)),h=f>0?-s:Math.min(Math.max(-s,-l),s),d=-f*f+h*(h+2*l)+c):h<=p?(f=0,h=Math.min(Math.max(-s,-l),s),d=h*(h+2*l)+c):(f=Math.max(0,-(o*s+a)),h=f>0?s:Math.min(Math.max(-s,-l),s),d=-f*f+h*(h+2*l)+c);else h=o>0?-s:s,f=Math.max(0,-(o*h+a)),d=-f*f+h*(h+2*l)+c;return n&&n.copy(this.origin).addScaledVector(this.direction,f),r&&r.copy(Kd).addScaledVector(Yu,h),d}intersectSphere(e,t){if(e.radius<0)return null;gr.subVectors(e.center,this.origin);let n=gr.dot(this.direction),r=gr.dot(gr)-n*n,s=e.radius*e.radius;if(r>s)return null;let o=Math.sqrt(s-r),a=n-o,l=n+o;return l<0?null:a<0?this.at(l,t):this.at(a,t)}intersectsSphere(e){return e.radius<0?!1:this.distanceSqToPoint(e.center)<=e.radius*e.radius}distanceToPlane(e){let t=e.normal.dot(this.direction);if(t===0)return e.distanceToPoint(this.origin)===0?0:null;let n=-(this.origin.dot(e.normal)+e.constant)/t;return n>=0?n:null}intersectPlane(e,t){let n=this.distanceToPlane(e);return n===null?null:this.at(n,t)}intersectsPlane(e){let t=e.distanceToPoint(this.origin);return t===0||e.normal.dot(this.direction)*t<0}intersectBox(e,t){let n,r,s,o,a,l,c=1/this.direction.x,u=1/this.direction.y,f=1/this.direction.z,h=this.origin;return c>=0?(n=(e.min.x-h.x)*c,r=(e.max.x-h.x)*c):(n=(e.max.x-h.x)*c,r=(e.min.x-h.x)*c),u>=0?(s=(e.min.y-h.y)*u,o=(e.max.y-h.y)*u):(s=(e.max.y-h.y)*u,o=(e.min.y-h.y)*u),n>o||s>r||((s>n||isNaN(n))&&(n=s),(o<r||isNaN(r))&&(r=o),f>=0?(a=(e.min.z-h.z)*f,l=(e.max.z-h.z)*f):(a=(e.max.z-h.z)*f,l=(e.min.z-h.z)*f),n>l||a>r)||((a>n||n!==n)&&(n=a),(l<r||r!==r)&&(r=l),r<0)?null:this.at(n>=0?n:r,t)}intersectsBox(e){return this.intersectBox(e,gr)!==null}intersectTriangle(e,t,n,r,s){let o=this.origin,a=this.direction,l=a.x,c=a.y,u=a.z,f=e.x-o.x,h=e.y-o.y,d=e.z-o.z,p=t.x-o.x,v=t.y-o.y,g=t.z-o.z,m=n.x-o.x,y=n.y-o.y,_=n.z-o.z,x=Math.abs(l),S=Math.abs(c),b=Math.abs(u),E,M,T,A,I,D,B,F,L,U,X,te;if(x>=S&&x>=b?(T=l,D=f,L=p,te=m,l>=0?(E=c,M=u,A=h,I=d,B=v,F=g,U=y,X=_):(E=u,M=c,A=d,I=h,B=g,F=v,U=_,X=y)):S>=b?(T=c,D=h,L=v,te=y,c>=0?(E=u,M=l,A=d,I=f,B=g,F=p,U=_,X=m):(E=l,M=u,A=f,I=d,B=p,F=g,U=m,X=_)):(T=u,D=d,L=g,te=_,u>=0?(E=l,M=c,A=f,I=h,B=p,F=v,U=m,X=y):(E=c,M=l,A=h,I=f,B=v,F=p,U=y,X=m)),T===0)return null;let Z=E/T,K=M/T,j=1/T,ne=A-Z*D,ie=I-K*D,We=B-Z*L,Fe=F-K*L,Ye=U-Z*te,$=X-K*te,oe=Ye*Fe-$*We,Ce=ne*$-ie*Ye,He=We*ie-Fe*ne;if(r){if(oe<0||Ce<0||He<0)return null}else if((oe<0||Ce<0||He<0)&&(oe>0||Ce>0||He>0))return null;let Ee=oe+Ce+He;if(Ee===0)return null;let ze=j*(oe*D+Ce*L+He*te);return(Ee>0?ze<0:ze>0)?null:this.at(ze/Ee,s)}applyMatrix4(e){return this.origin.applyMatrix4(e),this.direction.transformDirection(e),this}equals(e){return e.origin.equals(this.origin)&&e.direction.equals(this.direction)}clone(){return new this.constructor().copy(this)}},Hn=class extends an{constructor(e){super(),this.isMeshBasicMaterial=!0,this.type="MeshBasicMaterial",this.color=new be(16777215),this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.specularMap=null,this.alphaMap=null,this.envMap=null,this.envMapRotation=new Vn,this.combine=fa,this.reflectivity=1,this.refractionRatio=.98,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.lightMap=e.lightMap,this.lightMapIntensity=e.lightMapIntensity,this.aoMap=e.aoMap,this.aoMapIntensity=e.aoMapIntensity,this.specularMap=e.specularMap,this.alphaMap=e.alphaMap,this.envMap=e.envMap,this.envMapRotation.copy(e.envMapRotation),this.combine=e.combine,this.reflectivity=e.reflectivity,this.refractionRatio=e.refractionRatio,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.wireframeLinecap=e.wireframeLinecap,this.wireframeLinejoin=e.wireframeLinejoin,this.fog=e.fog,this}},z0=new it,ds=new Mr,$u=new on,k0=new R,Ju=new R,Ku=new R,ju=new R,jd=new R,Qu=new R,G0=new R,eh=new R,at=class extends At{constructor(e=new et,t=new Hn){super(),this.isMesh=!0,this.type="Mesh",this.geometry=e,this.material=t,this.morphTargetDictionary=void 0,this.morphTargetInfluences=void 0,this.count=1,this.updateMorphTargets()}copy(e,t){return super.copy(e,t),e.morphTargetInfluences!==void 0&&(this.morphTargetInfluences=e.morphTargetInfluences.slice()),e.morphTargetDictionary!==void 0&&(this.morphTargetDictionary=Object.assign({},e.morphTargetDictionary)),this.material=Array.isArray(e.material)?e.material.slice():e.material,this.geometry=e.geometry,this}updateMorphTargets(){let t=this.geometry.morphAttributes,n=Object.keys(t);if(n.length>0){let r=t[n[0]];if(r!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let s=0,o=r.length;s<o;s++){let a=r[s].name||String(s);this.morphTargetInfluences.push(0),this.morphTargetDictionary[a]=s}}}}getVertexPosition(e,t){let n=this.geometry,r=n.attributes.position,s=n.morphAttributes.position,o=n.morphTargetsRelative;t.fromBufferAttribute(r,e);let a=this.morphTargetInfluences;if(s&&a){Qu.set(0,0,0);for(let l=0,c=s.length;l<c;l++){let u=a[l],f=s[l];u!==0&&(jd.fromBufferAttribute(f,e),o?Qu.addScaledVector(jd,u):Qu.addScaledVector(jd.sub(t),u))}t.add(Qu)}return t}intersectsFrustum(e){return e.intersectsObject(this)}raycast(e,t){let n=this.geometry,r=this.material,s=this.matrixWorld;r!==void 0&&(n.boundingSphere===null&&n.computeBoundingSphere(),$u.copy(n.boundingSphere),$u.applyMatrix4(s),ds.copy(e.ray).recast(e.near),!($u.containsPoint(ds.origin)===!1&&(ds.intersectSphere($u,k0)===null||ds.origin.distanceToSquared(k0)>(e.far-e.near)**2))&&(z0.copy(s).invert(),ds.copy(e.ray).applyMatrix4(z0),!(n.boundingBox!==null&&ds.intersectsBox(n.boundingBox)===!1)&&this._computeIntersections(e,t,ds)))}_computeIntersections(e,t,n){let r,s=this.geometry,o=this.material,a=s.index,l=s.attributes.position,c=s.attributes.uv,u=s.attributes.uv1,f=s.attributes.normal,h=s.groups,d=s.drawRange;if(a!==null)if(Array.isArray(o))for(let p=0,v=h.length;p<v;p++){let g=h[p],m=o[g.materialIndex],y=Math.max(g.start,d.start),_=Math.min(a.count,Math.min(g.start+g.count,d.start+d.count));for(let x=y,S=_;x<S;x+=3){let b=a.getX(x),E=a.getX(x+1),M=a.getX(x+2);r=th(this,m,e,n,c,u,f,b,E,M),r&&(r.faceIndex=Math.floor(x/3),r.face.materialIndex=g.materialIndex,t.push(r))}}else{let p=Math.max(0,d.start),v=Math.min(a.count,d.start+d.count);for(let g=p,m=v;g<m;g+=3){let y=a.getX(g),_=a.getX(g+1),x=a.getX(g+2);r=th(this,o,e,n,c,u,f,y,_,x),r&&(r.faceIndex=Math.floor(g/3),t.push(r))}}else if(l!==void 0)if(Array.isArray(o))for(let p=0,v=h.length;p<v;p++){let g=h[p],m=o[g.materialIndex],y=Math.max(g.start,d.start),_=Math.min(l.count,Math.min(g.start+g.count,d.start+d.count));for(let x=y,S=_;x<S;x+=3){let b=x,E=x+1,M=x+2;r=th(this,m,e,n,c,u,f,b,E,M),r&&(r.faceIndex=Math.floor(x/3),r.face.materialIndex=g.materialIndex,t.push(r))}}else{let p=Math.max(0,d.start),v=Math.min(l.count,d.start+d.count);for(let g=p,m=v;g<m;g+=3){let y=g,_=g+1,x=g+2;r=th(this,o,e,n,c,u,f,y,_,x),r&&(r.faceIndex=Math.floor(g/3),t.push(r))}}}};function p_(i,e,t,n,r,s,o,a){let l;if(e.side===gn?l=n.intersectTriangle(o,s,r,!0,a):l=n.intersectTriangle(r,s,o,e.side===Er,a),l===null)return null;eh.copy(a),eh.applyMatrix4(i.matrixWorld);let c=t.ray.origin.distanceTo(eh);return c<t.near||c>t.far?null:{distance:c,point:eh.clone(),object:i}}function th(i,e,t,n,r,s,o,a,l,c){i.getVertexPosition(a,Ju),i.getVertexPosition(l,Ku),i.getVertexPosition(c,ju);let u=p_(i,e,t,n,Ju,Ku,ju,G0);if(u){let f=new R;Ni.getBarycoord(G0,Ju,Ku,ju,f),r&&(u.uv=Ni.getInterpolatedAttribute(r,a,l,c,f,new he)),s&&(u.uv1=Ni.getInterpolatedAttribute(s,a,l,c,f,new he)),o&&(u.normal=Ni.getInterpolatedAttribute(o,a,l,c,f,new R),u.normal.dot(n.direction)>0&&u.normal.multiplyScalar(-1));let h={a,b:l,c,normal:new R,materialIndex:0};Ni.getNormal(Ju,Ku,ju,h.normal),u.face=h,u.barycoord=f}return u}var nl=new Pt,V0=new Pt,H0=new Pt,m_=new Pt,W0=new it,nh=new R,Qd=new on,X0=new it,ep=new Mr,El=class extends at{constructor(e,t){super(e,t),this.isSkinnedMesh=!0,this.type="SkinnedMesh",this.bindMode=Th,this.bindMatrix=new it,this.bindMatrixInverse=new it,this.boundingBox=null,this.boundingSphere=null}computeBoundingBox(){let e=this.geometry;this.boundingBox===null&&(this.boundingBox=new cn),this.boundingBox.makeEmpty();let t=e.getAttribute("position");for(let n=0;n<t.count;n++)this.getVertexPosition(n,nh),this.boundingBox.expandByPoint(nh)}computeBoundingSphere(){let e=this.geometry;this.boundingSphere===null&&(this.boundingSphere=new on),this.boundingSphere.makeEmpty();let t=e.getAttribute("position");for(let n=0;n<t.count;n++)this.getVertexPosition(n,nh),this.boundingSphere.expandByPoint(nh)}copy(e,t){return super.copy(e,t),this.bindMode=e.bindMode,this.bindMatrix.copy(e.bindMatrix),this.bindMatrixInverse.copy(e.bindMatrixInverse),this.skeleton=e.skeleton,e.boundingBox!==null&&(this.boundingBox=e.boundingBox.clone()),e.boundingSphere!==null&&(this.boundingSphere=e.boundingSphere.clone()),this}raycast(e,t){let n=this.material,r=this.matrixWorld;n!==void 0&&(this.boundingSphere===null&&this.computeBoundingSphere(),Qd.copy(this.boundingSphere),Qd.applyMatrix4(r),e.ray.intersectsSphere(Qd)!==!1&&(X0.copy(r).invert(),ep.copy(e.ray).applyMatrix4(X0),!(this.boundingBox!==null&&ep.intersectsBox(this.boundingBox)===!1)&&this._computeIntersections(e,t,ep)))}getVertexPosition(e,t){return super.getVertexPosition(e,t),this.applyBoneTransform(e,t),t}bind(e,t){this.skeleton=e,t===void 0&&(this.updateMatrixWorld(!0),this.skeleton.calculateInverses(),t=this.matrixWorld),this.bindMatrix.copy(t),this.bindMatrixInverse.copy(t).invert()}pose(){this.skeleton.pose()}normalizeSkinWeights(){let e=new Pt,t=this.geometry.attributes.skinWeight;for(let n=0,r=t.count;n<r;n++){e.fromBufferAttribute(t,n);let s=1/e.manhattanLength();s!==1/0?e.multiplyScalar(s):e.set(1,0,0,0),t.setXYZW(n,e.x,e.y,e.z,e.w)}}updateMatrixWorld(e){super.updateMatrixWorld(e),this.bindMode===Th?this.bindMatrixInverse.copy(this.matrixWorld).invert():this.bindMode===Kp?this.bindMatrixInverse.copy(this.bindMatrix).invert():Ge("SkinnedMesh: Unrecognized bindMode: "+this.bindMode)}applyBoneTransform(e,t){let n=this.skeleton,r=this.geometry;V0.fromBufferAttribute(r.attributes.skinIndex,e),H0.fromBufferAttribute(r.attributes.skinWeight,e),t.isVector4?(nl.copy(t),t.set(0,0,0,0)):(nl.set(...t,1),t.set(0,0,0)),nl.applyMatrix4(this.bindMatrix);for(let s=0;s<4;s++){let o=H0.getComponent(s);if(o!==0){let a=V0.getComponent(s);W0.multiplyMatrices(n.bones[a].matrixWorld,n.boneInverses[a]),t.addScaledVector(m_.copy(nl).applyMatrix4(W0),o)}}return t.isVector4&&(t.w=nl.w),t.applyMatrix4(this.bindMatrixInverse)}},qo=class extends At{constructor(){super(),this.isBone=!0,this.type="Bone"}},Gn=class extends jt{constructor(e=null,t=1,n=1,r,s,o,a,l,c=Kt,u=Kt,f,h){super(null,o,a,l,c,u,r,s,f,h),this.isDataTexture=!0,this.image={data:e,width:t,height:n},this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}},q0=new it,g_=new it,Cl=class i{constructor(e=[],t=[]){this.uuid=ai(),this.bones=e.slice(0),this.boneInverses=t,this.boneMatrices=null,this.boneTexture=null,this.init()}init(){let e=this.bones,t=this.boneInverses;if(this.boneMatrices=new Float32Array(e.length*16),t.length===0)this.calculateInverses();else if(e.length!==t.length){Ge("Skeleton: Number of inverse bone matrices does not match amount of bones."),this.boneInverses=[];for(let n=0,r=this.bones.length;n<r;n++)this.boneInverses.push(new it)}}calculateInverses(){this.boneInverses.length=0;for(let e=0,t=this.bones.length;e<t;e++){let n=new it;this.bones[e]&&n.copy(this.bones[e].matrixWorld).invert(),this.boneInverses.push(n)}}pose(){for(let e=0,t=this.bones.length;e<t;e++){let n=this.bones[e];n&&n.matrixWorld.copy(this.boneInverses[e]).invert()}for(let e=0,t=this.bones.length;e<t;e++){let n=this.bones[e];n&&(n.parent&&n.parent.isBone?(n.matrix.copy(n.parent.matrixWorld).invert(),n.matrix.multiply(n.matrixWorld)):n.matrix.copy(n.matrixWorld),n.matrix.decompose(n.position,n.quaternion,n.scale))}}update(){let e=this.bones,t=this.boneInverses,n=this.boneMatrices,r=this.boneTexture;for(let s=0,o=e.length;s<o;s++){let a=e[s]?e[s].matrixWorld:g_;q0.multiplyMatrices(a,t[s]),q0.toArray(n,s*16)}r!==null&&(r.needsUpdate=!0)}clone(){return new i(this.bones,this.boneInverses)}computeBoneTexture(){let e=Math.sqrt(this.bones.length*4);e=Math.ceil(e/4)*4,e=Math.max(e,4);let t=new Float32Array(e*e*4);t.set(this.boneMatrices);let n=new Gn(t,e,e,Pn,Rn);return n.needsUpdate=!0,this.boneMatrices=t,this.boneTexture=n,this}getBoneByName(e){for(let t=0,n=this.bones.length;t<n;t++){let r=this.bones[t];if(r.name===e)return r}}dispose(){this.boneTexture!==null&&(this.boneTexture.dispose(),this.boneTexture=null)}fromJSON(e,t){this.uuid=e.uuid;for(let n=0,r=e.bones.length;n<r;n++){let s=e.bones[n],o=t[s];o===void 0&&(Ge("Skeleton: No bone found with UUID:",s),o=new qo),this.bones.push(o),this.boneInverses.push(new it().fromArray(e.boneInverses[n]))}return this.init(),this}toJSON(){let e={metadata:{version:4.7,type:"Skeleton",generator:"Skeleton.toJSON"},bones:[],boneInverses:[]};e.uuid=this.uuid;let t=this.bones,n=this.boneInverses;for(let r=0,s=t.length;r<s;r++){let o=t[r];e.bones.push(o.uuid);let a=n[r];e.boneInverses.push(a.toArray())}return e}},wi=class extends ht{constructor(e,t,n,r=1){super(e,t,n),this.isInstancedBufferAttribute=!0,this.meshPerAttribute=r}copy(e){return super.copy(e),this.meshPerAttribute=e.meshPerAttribute,this}toJSON(){let e=super.toJSON();return e.meshPerAttribute=this.meshPerAttribute,e.isInstancedBufferAttribute=!0,e}},Eo=new it,Y0=new it,ih=[],Z0=new cn,v_=new it,il=new at,rl=new on,Ji=class extends at{constructor(e,t,n){super(e,t),this.isInstancedMesh=!0,this.instanceMatrix=new wi(new Float32Array(n*16),16),this.instanceColor=null,this.morphTexture=null,this.count=n,this.boundingBox=null,this.boundingSphere=null;for(let r=0;r<n;r++)this.setMatrixAt(r,v_)}computeBoundingBox(){let e=this.geometry,t=this.count;this.boundingBox===null&&(this.boundingBox=new cn),e.boundingBox===null&&e.computeBoundingBox(),this.boundingBox.makeEmpty();for(let n=0;n<t;n++)this.getMatrixAt(n,Eo),Z0.copy(e.boundingBox).applyMatrix4(Eo),this.boundingBox.union(Z0)}computeBoundingSphere(){let e=this.geometry,t=this.count;this.boundingSphere===null&&(this.boundingSphere=new on),e.boundingSphere===null&&e.computeBoundingSphere(),this.boundingSphere.makeEmpty();for(let n=0;n<t;n++)this.getMatrixAt(n,Eo),rl.copy(e.boundingSphere).applyMatrix4(Eo),this.boundingSphere.union(rl)}copy(e,t){return super.copy(e,t),this.instanceMatrix.copy(e.instanceMatrix),e.morphTexture!==null&&(this.morphTexture=e.morphTexture.clone()),e.instanceColor!==null&&(this.instanceColor=e.instanceColor.clone()),this.count=e.count,e.boundingBox!==null&&(this.boundingBox=e.boundingBox.clone()),e.boundingSphere!==null&&(this.boundingSphere=e.boundingSphere.clone()),this}getColorAt(e,t){return this.instanceColor===null?t.setRGB(1,1,1):t.fromArray(this.instanceColor.array,e*3)}getMatrixAt(e,t){return t.fromArray(this.instanceMatrix.array,e*16)}getMorphAt(e,t){let n=t.morphTargetInfluences,r=this.morphTexture.source.data.data,s=n.length+1,o=e*s+1;for(let a=0;a<n.length;a++)n[a]=r[o+a]}raycast(e,t){let n=this.matrixWorld,r=this.count;if(il.geometry=this.geometry,il.material=this.material,il.material!==void 0&&(this.boundingSphere===null&&this.computeBoundingSphere(),rl.copy(this.boundingSphere),rl.applyMatrix4(n),e.ray.intersectsSphere(rl)!==!1))for(let s=0;s<r;s++){this.getMatrixAt(s,Eo),Y0.multiplyMatrices(n,Eo),il.matrixWorld=Y0,il.raycast(e,ih);for(let o=0,a=ih.length;o<a;o++){let l=ih[o];l.instanceId=s,l.object=this,t.push(l)}ih.length=0}}setColorAt(e,t){return this.instanceColor===null&&(this.instanceColor=new wi(new Float32Array(this.instanceMatrix.count*3).fill(1),3)),t.toArray(this.instanceColor.array,e*3),this}setMatrixAt(e,t){return t.toArray(this.instanceMatrix.array,e*16),this}setMorphAt(e,t){let n=t.morphTargetInfluences,r=n.length+1;this.morphTexture===null&&(this.morphTexture=new Gn(new Float32Array(r*this.count),r,this.count,Ac,Rn));let s=this.morphTexture.source.data.data,o=0;for(let c=0;c<n.length;c++)o+=n[c];let a=this.geometry.morphTargetsRelative?1:1-o,l=r*e;return s[l]=a,s.set(n,l+1),this}updateMorphTargets(){}dispose(){super.dispose(),this.morphTexture!==null&&(this.morphTexture.dispose(),this.morphTexture=null)}},ps=new on,x_=new he(.5,.5),rh=new R,Ki=class{constructor(e=new Mi,t=new Mi,n=new Mi,r=new Mi,s=new Mi,o=new Mi){this.planes=[e,t,n,r,s,o]}set(e,t,n,r,s,o){let a=this.planes;return a[0].copy(e),a[1].copy(t),a[2].copy(n),a[3].copy(r),a[4].copy(s),a[5].copy(o),this}copy(e){let t=this.planes;for(let n=0;n<6;n++)t[n].copy(e.planes[n]);return this}setFromProjectionMatrix(e,t=Kn,n=!1){let r=this.planes,s=e.elements,o=s[0],a=s[1],l=s[2],c=s[3],u=s[4],f=s[5],h=s[6],d=s[7],p=s[8],v=s[9],g=s[10],m=s[11],y=s[12],_=s[13],x=s[14],S=s[15];if(r[0].setComponents(c-o,d-u,m-p,S-y).normalize(),r[1].setComponents(c+o,d+u,m+p,S+y).normalize(),r[2].setComponents(c+a,d+f,m+v,S+_).normalize(),r[3].setComponents(c-a,d-f,m-v,S-_).normalize(),n)r[4].setComponents(l,h,g,x).normalize(),r[5].setComponents(c-l,d-h,m-g,S-x).normalize();else if(r[4].setComponents(c-l,d-h,m-g,S-x).normalize(),t===Kn)r[5].setComponents(c+l,d+h,m+g,S+x).normalize();else if(t===Zr)r[5].setComponents(l,h,g,x).normalize();else throw new Error("THREE.Frustum.setFromProjectionMatrix(): Invalid coordinate system: "+t);return this}intersectsObject(e){if(e.boundingSphere!==void 0)e.boundingSphere===null&&e.computeBoundingSphere(),ps.copy(e.boundingSphere).applyMatrix4(e.matrixWorld);else{let t=e.geometry;t.boundingSphere===null&&t.computeBoundingSphere(),ps.copy(t.boundingSphere).applyMatrix4(e.matrixWorld)}return this.intersectsSphere(ps)}intersectsSprite(e){ps.center.set(0,0,0);let t=x_.distanceTo(e.center);return ps.radius=.7071067811865476+t,ps.applyMatrix4(e.matrixWorld),this.intersectsSphere(ps)}intersectsSphere(e){let t=this.planes,n=e.center,r=-e.radius;for(let s=0;s<6;s++)if(t[s].distanceToPoint(n)<r)return!1;return!0}intersectsBox(e){let t=this.planes;for(let n=0;n<6;n++){let r=t[n];if(rh.x=r.normal.x>0?e.max.x:e.min.x,rh.y=r.normal.y>0?e.max.y:e.min.y,rh.z=r.normal.z>0?e.max.z:e.min.z,r.distanceToPoint(rh)<0)return!1}return!0}containsPoint(e){let t=this.planes;for(let n=0;n<6;n++)if(t[n].distanceToPoint(e)<0)return!1;return!0}clone(){return new this.constructor().copy(this)}},$0=new it,Rl=class i{constructor(){this.coordinateSystem=Kn,this._frustums=[],this._count=0}setFromArrayCamera(e){let t=e.cameras,n=this._frustums;for(let r=0;r<t.length;r++){let s=t[r];$0.multiplyMatrices(s.projectionMatrix,s.matrixWorldInverse),n[r]===void 0&&(n[r]=new Ki),n[r].setFromProjectionMatrix($0,s.coordinateSystem,s.reversedDepth)}return this._count=t.length,this}intersectsObject(e){let t=this._frustums;for(let n=0;n<this._count;n++)if(t[n].intersectsObject(e))return!0;return!1}intersectsSprite(e){let t=this._frustums;for(let n=0;n<this._count;n++)if(t[n].intersectsSprite(e))return!0;return!1}intersectsSphere(e){let t=this._frustums;for(let n=0;n<this._count;n++)if(t[n].intersectsSphere(e))return!0;return!1}intersectsBox(e){let t=this._frustums;for(let n=0;n<this._count;n++)if(t[n].intersectsBox(e))return!0;return!1}containsPoint(e){let t=this._frustums;for(let n=0;n<this._count;n++)if(t[n].containsPoint(e))return!0;return!1}copy(e){this.coordinateSystem=e.coordinateSystem;let t=this._frustums,n=e._frustums;for(let r=0;r<e._count;r++)t[r]===void 0&&(t[r]=new Ki),t[r].copy(n[r]);return this._count=e._count,this}clone(){return new i().copy(this)}};function tp(i,e){return i-e}function y_(i,e){return i.z-e.z}function __(i,e){return e.z-i.z}var mp=class{constructor(){this.index=0,this.pool=[],this.list=[]}push(e,t,n,r){let s=this.pool,o=this.list;this.index>=s.length&&s.push({start:-1,count:-1,z:-1,index:-1});let a=s[this.index];o.push(a),this.index++,a.start=e,a.count=t,a.z=n,a.index=r}reset(){this.list.length=0,this.index=0}},$n=new it,M_=new be(1,1,1),S_=new Ki,b_=new Rl,sh=new cn,ms=new on,sl=new R,J0=new R,w_=new R,np=new mp,Cn=new at,oh=[];function T_(i,e,t=0){let n=e.itemSize;if(i.isInterleavedBufferAttribute||i.array.constructor!==e.array.constructor){let r=i.count;for(let s=0;s<r;s++)for(let o=0;o<n;o++)e.setComponent(s+t,o,i.getComponent(s,o))}else e.array.set(i.array,t*n);e.needsUpdate=!0}function gs(i,e){if(i.constructor!==e.constructor){let t=Math.min(i.length,e.length);for(let n=0;n<t;n++)e[n]=i[n]}else{let t=Math.min(i.length,e.length);e.set(new i.constructor(i.buffer,0,t))}}var Pl=class extends at{constructor(e,t,n=t*2,r){super(new et,r),this.isBatchedMesh=!0,this.perObjectFrustumCulled=!0,this.sortObjects=!0,this.boundingBox=null,this.boundingSphere=null,this.customSort=null,this._instanceInfo=[],this._geometryInfo=[],this._availableInstanceIds=[],this._availableGeometryIds=[],this._nextIndexStart=0,this._nextVertexStart=0,this._geometryCount=0,this._visibilityChanged=!0,this._geometryInitialized=!1,this._maxInstanceCount=e,this._maxVertexCount=t,this._maxIndexCount=n,this._multiDrawCounts=new Int32Array(e),this._multiDrawStarts=new Int32Array(e),this._multiDrawCount=0,this._multiDrawBytesPerElement=1,this._matricesTexture=null,this._indirectTexture=null,this._colorsTexture=null,this._initMatricesTexture(),this._initIndirectTexture()}get maxInstanceCount(){return this._maxInstanceCount}get instanceCount(){return this._instanceInfo.length-this._availableInstanceIds.length}get unusedVertexCount(){return this._maxVertexCount-this._nextVertexStart}get unusedIndexCount(){return this._maxIndexCount-this._nextIndexStart}_initMatricesTexture(){let e=Math.sqrt(this._maxInstanceCount*4);e=Math.ceil(e/4)*4,e=Math.max(e,4);let t=new Float32Array(e*e*4),n=new Gn(t,e,e,Pn,Rn);this._matricesTexture=n}_initIndirectTexture(){let e=Math.sqrt(this._maxInstanceCount);e=Math.ceil(e);let t=new Uint32Array(e*e),n=new Gn(t,e,e,Sa,hi);this._indirectTexture=n}_initColorsTexture(){let e=Math.sqrt(this._maxInstanceCount);e=Math.ceil(e);let t=new Float32Array(e*e*4).fill(1),n=new Gn(t,e,e,Pn,Rn);n.colorSpace=vt.workingColorSpace,this._colorsTexture=n}_initializeGeometry(e){let t=this.geometry,n=this._maxVertexCount,r=this._maxIndexCount;if(this._geometryInitialized===!1){for(let s in e.attributes){let o=e.getAttribute(s),{array:a,itemSize:l,normalized:c}=o,u=new a.constructor(n*l),f=new ht(u,l,c);t.setAttribute(s,f)}if(e.getIndex()!==null){let s=n>65535?new Uint32Array(r):new Uint16Array(r);t.setIndex(new ht(s,1))}this._geometryInitialized=!0}}_validateGeometry(e){let t=this.geometry;if(!!e.getIndex()!=!!t.getIndex())throw new Error('THREE.BatchedMesh: All geometries must consistently have "index".');for(let n in t.attributes){if(!e.hasAttribute(n))throw new Error(`THREE.BatchedMesh: Added geometry missing "${n}". All geometries must have consistent attributes.`);let r=e.getAttribute(n),s=t.getAttribute(n);if(r.itemSize!==s.itemSize||r.normalized!==s.normalized)throw new Error("THREE.BatchedMesh: All attributes must have a consistent itemSize and normalized value.")}}validateInstanceId(e){let t=this._instanceInfo;if(e<0||e>=t.length||t[e].active===!1)throw new Error(`THREE.BatchedMesh: Invalid instanceId ${e}. Instance is either out of range or has been deleted.`)}validateGeometryId(e){let t=this._geometryInfo;if(e<0||e>=t.length||t[e].active===!1)throw new Error(`THREE.BatchedMesh: Invalid geometryId ${e}. Geometry is either out of range or has been deleted.`)}setCustomSort(e){return this.customSort=e,this}computeBoundingBox(){this.boundingBox===null&&(this.boundingBox=new cn);let e=this.boundingBox,t=this._instanceInfo;e.makeEmpty();for(let n=0,r=t.length;n<r;n++){if(t[n].active===!1)continue;let s=t[n].geometryIndex;this.getMatrixAt(n,$n),this.getBoundingBoxAt(s,sh).applyMatrix4($n),e.union(sh)}}computeBoundingSphere(){this.boundingSphere===null&&(this.boundingSphere=new on);let e=this.boundingSphere,t=this._instanceInfo;e.makeEmpty();for(let n=0,r=t.length;n<r;n++){if(t[n].active===!1)continue;let s=t[n].geometryIndex;this.getMatrixAt(n,$n),this.getBoundingSphereAt(s,ms).applyMatrix4($n),e.union(ms)}}addInstance(e){if(this._instanceInfo.length>=this.maxInstanceCount&&this._availableInstanceIds.length===0)throw new Error("THREE.BatchedMesh: Maximum item count reached.");let n={visible:!0,active:!0,geometryIndex:e},r=null;this._availableInstanceIds.length>0?(this._availableInstanceIds.sort(tp),r=this._availableInstanceIds.shift(),this._instanceInfo[r]=n):(r=this._instanceInfo.length,this._instanceInfo.push(n));let s=this._matricesTexture;$n.identity().toArray(s.image.data,r*16),s.needsUpdate=!0;let o=this._colorsTexture;return o&&(M_.toArray(o.image.data,r*4),o.needsUpdate=!0),this._visibilityChanged=!0,r}addGeometry(e,t=-1,n=-1){this._initializeGeometry(e),this._validateGeometry(e);let r={vertexStart:-1,vertexCount:-1,reservedVertexCount:-1,indexStart:-1,indexCount:-1,reservedIndexCount:-1,start:-1,count:-1,boundingBox:null,boundingSphere:null,active:!0},s=this._geometryInfo;r.vertexStart=this._nextVertexStart,r.reservedVertexCount=t===-1?e.getAttribute("position").count:t;let o=e.getIndex();if(o!==null&&(r.indexStart=this._nextIndexStart,r.reservedIndexCount=n===-1?o.count:n),r.indexStart!==-1&&r.indexStart+r.reservedIndexCount>this._maxIndexCount||r.vertexStart+r.reservedVertexCount>this._maxVertexCount)throw new Error("THREE.BatchedMesh: Reserved space request exceeds the maximum buffer size.");let l;return this._availableGeometryIds.length>0?(this._availableGeometryIds.sort(tp),l=this._availableGeometryIds.shift(),s[l]=r):(l=this._geometryCount,this._geometryCount++,s.push(r)),this.setGeometryAt(l,e),this._nextIndexStart=r.indexStart+r.reservedIndexCount,this._nextVertexStart=r.vertexStart+r.reservedVertexCount,l}setGeometryAt(e,t){if(e>=this._geometryCount)throw new Error("THREE.BatchedMesh: Maximum geometry count reached.");this._validateGeometry(t);let n=this.geometry,r=n.getIndex()!==null,s=n.getIndex(),o=t.getIndex(),a=this._geometryInfo[e];if(r&&o.count>a.reservedIndexCount||t.attributes.position.count>a.reservedVertexCount)throw new Error("THREE.BatchedMesh: Reserved space not large enough for provided geometry.");let l=a.vertexStart,c=a.reservedVertexCount;a.vertexCount=t.getAttribute("position").count;for(let u in n.attributes){let f=t.getAttribute(u),h=n.getAttribute(u);T_(f,h,l);let d=f.itemSize;for(let p=f.count,v=c;p<v;p++){let g=l+p;for(let m=0;m<d;m++)h.setComponent(g,m,0)}h.needsUpdate=!0,h.addUpdateRange(l*d,c*d)}if(r){let u=a.indexStart,f=a.reservedIndexCount;a.indexCount=t.getIndex().count;for(let h=0;h<o.count;h++)s.setX(u+h,l+o.getX(h));for(let h=o.count,d=f;h<d;h++)s.setX(u+h,l);s.needsUpdate=!0,s.addUpdateRange(u,a.reservedIndexCount)}return a.start=r?a.indexStart:a.vertexStart,a.count=r?a.indexCount:a.vertexCount,a.boundingBox=null,t.boundingBox!==null&&(a.boundingBox=t.boundingBox.clone()),a.boundingSphere=null,t.boundingSphere!==null&&(a.boundingSphere=t.boundingSphere.clone()),this._visibilityChanged=!0,e}deleteGeometry(e){let t=this._geometryInfo;if(e>=t.length||t[e].active===!1)return this;let n=this._instanceInfo;for(let r=0,s=n.length;r<s;r++)n[r].active&&n[r].geometryIndex===e&&this.deleteInstance(r);return t[e].active=!1,this._availableGeometryIds.push(e),this._visibilityChanged=!0,this}deleteInstance(e){return this.validateInstanceId(e),this._instanceInfo[e].active=!1,this._availableInstanceIds.push(e),this._visibilityChanged=!0,this}optimize(){let e=0,t=0,n=this._geometryInfo,r=n.map((o,a)=>a).sort((o,a)=>n[o].vertexStart-n[a].vertexStart),s=this.geometry;for(let o=0,a=n.length;o<a;o++){let l=r[o],c=n[l];if(c.active!==!1){if(s.index!==null){if(c.indexStart!==t){let{indexStart:u,vertexStart:f,reservedIndexCount:h}=c,d=s.index,p=d.array,v=e-f;for(let g=u;g<u+h;g++)p[g]=p[g]+v;d.array.copyWithin(t,u,u+h),d.addUpdateRange(t,h),d.needsUpdate=!0,c.indexStart=t}t+=c.reservedIndexCount}if(c.vertexStart!==e){let{vertexStart:u,reservedVertexCount:f}=c,h=s.attributes;for(let d in h){let p=h[d],{array:v,itemSize:g}=p;v.copyWithin(e*g,u*g,(u+f)*g),p.addUpdateRange(e*g,f*g),p.needsUpdate=!0}c.vertexStart=e}e+=c.reservedVertexCount,c.start=s.index?c.indexStart:c.vertexStart}}return this._nextIndexStart=t,this._nextVertexStart=e,this._visibilityChanged=!0,this}getBoundingBoxAt(e,t){if(e>=this._geometryCount)return null;let n=this.geometry,r=this._geometryInfo[e];if(r.boundingBox===null){let s=new cn,o=n.index,a=n.attributes.position;for(let l=r.start,c=r.start+r.count;l<c;l++){let u=l;o&&(u=o.getX(u)),s.expandByPoint(sl.fromBufferAttribute(a,u))}r.boundingBox=s}return t.copy(r.boundingBox),t}getBoundingSphereAt(e,t){if(e>=this._geometryCount)return null;let n=this.geometry,r=this._geometryInfo[e];if(r.boundingSphere===null){let s=new on;this.getBoundingBoxAt(e,sh),sh.getCenter(s.center);let o=n.index,a=n.attributes.position,l=0;for(let c=r.start,u=r.start+r.count;c<u;c++){let f=c;o&&(f=o.getX(f)),sl.fromBufferAttribute(a,f),l=Math.max(l,s.center.distanceToSquared(sl))}s.radius=Math.sqrt(l),r.boundingSphere=s}return t.copy(r.boundingSphere),t}setMatrixAt(e,t){this.validateInstanceId(e);let n=this._matricesTexture,r=this._matricesTexture.image.data;return t.toArray(r,e*16),n.needsUpdate=!0,this}getMatrixAt(e,t){return this.validateInstanceId(e),t.fromArray(this._matricesTexture.image.data,e*16)}setColorAt(e,t){return this.validateInstanceId(e),this._colorsTexture===null&&this._initColorsTexture(),t.toArray(this._colorsTexture.image.data,e*4),this._colorsTexture.needsUpdate=!0,this}getColorAt(e,t){return this.validateInstanceId(e),this._colorsTexture===null?t.isVector4?t.set(1,1,1,1):t.setRGB(1,1,1):t.fromArray(this._colorsTexture.image.data,e*4)}setVisibleAt(e,t){return this.validateInstanceId(e),this._instanceInfo[e].visible===t?this:(this._instanceInfo[e].visible=t,this._visibilityChanged=!0,this)}getVisibleAt(e){return this.validateInstanceId(e),this._instanceInfo[e].visible}setGeometryIdAt(e,t){return this.validateInstanceId(e),this.validateGeometryId(t),this._instanceInfo[e].geometryIndex=t,this._visibilityChanged=!0,this}getGeometryIdAt(e){return this.validateInstanceId(e),this._instanceInfo[e].geometryIndex}getGeometryRangeAt(e,t={}){this.validateGeometryId(e);let n=this._geometryInfo[e];return t.vertexStart=n.vertexStart,t.vertexCount=n.vertexCount,t.reservedVertexCount=n.reservedVertexCount,t.indexStart=n.indexStart,t.indexCount=n.indexCount,t.reservedIndexCount=n.reservedIndexCount,t.start=n.start,t.count=n.count,t}setInstanceCount(e){let t=this._availableInstanceIds,n=this._instanceInfo;for(t.sort(tp);t[t.length-1]===n.length-1;)n.pop(),t.pop();if(e<n.length)throw new Error(`THREE.BatchedMesh: Instance ids outside the range ${e} are being used. Cannot shrink instance count.`);let r=new Int32Array(e),s=new Int32Array(e);gs(this._multiDrawCounts,r),gs(this._multiDrawStarts,s),this._multiDrawCounts=r,this._multiDrawStarts=s,this._maxInstanceCount=e;let o=this._indirectTexture,a=this._matricesTexture,l=this._colorsTexture;o.dispose(),this._initIndirectTexture(),gs(o.image.data,this._indirectTexture.image.data),a.dispose(),this._initMatricesTexture(),gs(a.image.data,this._matricesTexture.image.data),l&&(l.dispose(),this._initColorsTexture(),gs(l.image.data,this._colorsTexture.image.data))}setGeometrySize(e,t){let n=[...this._geometryInfo].filter(a=>a.active);if(Math.max(...n.map(a=>a.vertexStart+a.reservedVertexCount))>e)throw new Error(`THREE.BatchedMesh: Geometry vertex values are being used outside the range ${t}. Cannot shrink further.`);if(this.geometry.index&&Math.max(...n.map(l=>l.indexStart+l.reservedIndexCount))>t)throw new Error(`THREE.BatchedMesh: Geometry index values are being used outside the range ${t}. Cannot shrink further.`);let s=this.geometry;s.dispose(),this._maxVertexCount=e,this._maxIndexCount=t,this._geometryInitialized&&(this._geometryInitialized=!1,this.geometry=new et,this._initializeGeometry(s));let o=this.geometry;s.index&&gs(s.index.array,o.index.array);for(let a in s.attributes)gs(s.attributes[a].array,o.attributes[a].array)}raycast(e,t){let n=this._instanceInfo,r=this._geometryInfo,s=this.matrixWorld,o=this.geometry;Cn.material=this.material,Cn.geometry.index=o.index,Cn.geometry.attributes=o.attributes,Cn.geometry.boundingBox===null&&(Cn.geometry.boundingBox=new cn),Cn.geometry.boundingSphere===null&&(Cn.geometry.boundingSphere=new on);for(let a=0,l=n.length;a<l;a++){if(!n[a].visible||!n[a].active)continue;let c=n[a].geometryIndex,u=r[c];Cn.geometry.setDrawRange(u.start,u.count),this.getMatrixAt(a,Cn.matrixWorld).premultiply(s),this.getBoundingBoxAt(c,Cn.geometry.boundingBox),this.getBoundingSphereAt(c,Cn.geometry.boundingSphere),Cn.raycast(e,oh);for(let f=0,h=oh.length;f<h;f++){let d=oh[f];d.object=this,d.batchId=a,t.push(d)}oh.length=0}Cn.material=null,Cn.geometry.index=null,Cn.geometry.attributes={},Cn.geometry.setDrawRange(0,1/0)}copy(e){return super.copy(e),this.geometry=e.geometry.clone(),this.perObjectFrustumCulled=e.perObjectFrustumCulled,this.sortObjects=e.sortObjects,this.boundingBox=e.boundingBox!==null?e.boundingBox.clone():null,this.boundingSphere=e.boundingSphere!==null?e.boundingSphere.clone():null,this._geometryInfo=e._geometryInfo.map(t=>({...t,boundingBox:t.boundingBox!==null?t.boundingBox.clone():null,boundingSphere:t.boundingSphere!==null?t.boundingSphere.clone():null})),this._instanceInfo=e._instanceInfo.map(t=>({...t})),this._availableInstanceIds=e._availableInstanceIds.slice(),this._availableGeometryIds=e._availableGeometryIds.slice(),this._nextIndexStart=e._nextIndexStart,this._nextVertexStart=e._nextVertexStart,this._geometryCount=e._geometryCount,this._maxInstanceCount=e._maxInstanceCount,this._maxVertexCount=e._maxVertexCount,this._maxIndexCount=e._maxIndexCount,this._geometryInitialized=e._geometryInitialized,this._multiDrawCounts=e._multiDrawCounts.slice(),this._multiDrawStarts=e._multiDrawStarts.slice(),this._multiDrawBytesPerElement=e._multiDrawBytesPerElement,this._indirectTexture=e._indirectTexture.clone(),this._indirectTexture.image.data=this._indirectTexture.image.data.slice(),this._matricesTexture=e._matricesTexture.clone(),this._matricesTexture.image.data=this._matricesTexture.image.data.slice(),this._colorsTexture!==null&&(this._colorsTexture=e._colorsTexture.clone(),this._colorsTexture.image.data=this._colorsTexture.image.data.slice()),this}dispose(){super.dispose(),this.geometry.dispose(),this._matricesTexture.dispose(),this._matricesTexture=null,this._indirectTexture.dispose(),this._indirectTexture=null,this._colorsTexture!==null&&(this._colorsTexture.dispose(),this._colorsTexture=null)}onBeforeRender(e,t,n,r,s){if(!this._visibilityChanged&&!this.perObjectFrustumCulled&&!this.sortObjects)return;let o=r.getIndex(),a=o===null?1:o.array.BYTES_PER_ELEMENT,l=1;s.wireframe&&(l=2,a=r.attributes.position.count>65535?4:2);let c=this._instanceInfo,u=this._multiDrawStarts,f=this._multiDrawCounts,h=this._geometryInfo,d=this.perObjectFrustumCulled,p=this._indirectTexture,v=p.image.data,g=n.isArrayCamera?b_:S_;d&&(n.isArrayCamera?g.setFromArrayCamera(n):($n.multiplyMatrices(n.projectionMatrix,n.matrixWorldInverse).multiply(this.matrixWorld),g.setFromProjectionMatrix($n,n.coordinateSystem,n.reversedDepth)));let m=0;if(this.sortObjects){$n.copy(this.matrixWorld).invert(),sl.setFromMatrixPosition(n.matrixWorld).applyMatrix4($n),J0.set(0,0,-1).transformDirection(n.matrixWorld).transformDirection($n);for(let x=0,S=c.length;x<S;x++)if(c[x].visible&&c[x].active){let b=c[x].geometryIndex;this.getMatrixAt(x,$n),this.getBoundingSphereAt(b,ms).applyMatrix4($n);let E=!1;if(d&&(E=!g.intersectsSphere(ms)),!E){let M=h[b],T=w_.subVectors(ms.center,sl).dot(J0);np.push(M.start,M.count,T,x)}}let y=np.list,_=this.customSort;_===null?y.sort(s.transparent?__:y_):_.call(this,y,n);for(let x=0,S=y.length;x<S;x++){let b=y[x];u[m]=b.start*a*l,f[m]=b.count*l,v[m]=b.index,m++}np.reset()}else for(let y=0,_=c.length;y<_;y++)if(c[y].visible&&c[y].active){let x=c[y].geometryIndex,S=!1;if(d&&(this.getMatrixAt(y,$n),this.getBoundingSphereAt(x,ms).applyMatrix4($n),S=!g.intersectsSphere(ms)),!S){let b=h[x];u[m]=b.start*a*l,f[m]=b.count*l,v[m]=y,m++}}p.needsUpdate=!0,this._multiDrawCount=m,this._multiDrawBytesPerElement=a,this._visibilityChanged=!1}onBeforeShadow(e,t,n,r,s,o){this.onBeforeRender(e,null,r,s,o)}},dn=class extends an{constructor(e){super(),this.isLineBasicMaterial=!0,this.type="LineBasicMaterial",this.color=new be(16777215),this.map=null,this.linewidth=1,this.linecap="round",this.linejoin="round",this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.linewidth=e.linewidth,this.linecap=e.linecap,this.linejoin=e.linejoin,this.fog=e.fog,this}},Bh=new R,Oh=new R,K0=new it,ol=new Mr,ah=new on,ip=new R,j0=new R,Bi=class extends At{constructor(e=new et,t=new dn){super(),this.isLine=!0,this.type="Line",this.geometry=e,this.material=t,this.morphTargetDictionary=void 0,this.morphTargetInfluences=void 0,this.updateMorphTargets()}copy(e,t){return super.copy(e,t),this.material=Array.isArray(e.material)?e.material.slice():e.material,this.geometry=e.geometry,this}computeLineDistances(){let e=this.geometry;if(e.index===null){let t=e.attributes.position,n=[0];for(let r=1,s=t.count;r<s;r++)Bh.fromBufferAttribute(t,r-1),Oh.fromBufferAttribute(t,r),n[r]=n[r-1],n[r]+=Bh.distanceTo(Oh);e.setAttribute("lineDistance",new Ve(n,1))}else Ge("Line.computeLineDistances(): Computation only possible with non-indexed BufferGeometry.");return this}intersectsFrustum(e){return e.intersectsObject(this)}raycast(e,t){let n=this.geometry,r=this.matrixWorld,s=e.params.Line.threshold,o=n.drawRange;if(n.boundingSphere===null&&n.computeBoundingSphere(),ah.copy(n.boundingSphere),ah.applyMatrix4(r),ah.radius+=s,e.ray.intersectsSphere(ah)===!1)return;K0.copy(r).invert(),ol.copy(e.ray).applyMatrix4(K0);let a=s/((this.scale.x+this.scale.y+this.scale.z)/3),l=a*a,c=this.isLineSegments?2:1,u=n.index,h=n.attributes.position;if(u!==null){let d=Math.max(0,o.start),p=Math.min(u.count,o.start+o.count);for(let v=d,g=p-1;v<g;v+=c){let m=u.getX(v),y=u.getX(v+1),_=lh(this,e,ol,l,m,y,v);_&&t.push(_)}if(this.isLineLoop){let v=u.getX(p-1),g=u.getX(d),m=lh(this,e,ol,l,v,g,p-1);m&&t.push(m)}}else{let d=Math.max(0,o.start),p=Math.min(h.count,o.start+o.count);for(let v=d,g=p-1;v<g;v+=c){let m=lh(this,e,ol,l,v,v+1,v);m&&t.push(m)}if(this.isLineLoop){let v=lh(this,e,ol,l,p-1,d,p-1);v&&t.push(v)}}}updateMorphTargets(){let t=this.geometry.morphAttributes,n=Object.keys(t);if(n.length>0){let r=t[n[0]];if(r!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let s=0,o=r.length;s<o;s++){let a=r[s].name||String(s);this.morphTargetInfluences.push(0),this.morphTargetDictionary[a]=s}}}}};function lh(i,e,t,n,r,s,o){let a=i.geometry.attributes.position;if(Bh.fromBufferAttribute(a,r),Oh.fromBufferAttribute(a,s),t.distanceSqToSegment(Bh,Oh,ip,j0)>n)return;ip.applyMatrix4(i.matrixWorld);let c=e.ray.origin.distanceTo(ip);if(!(c<e.near||c>e.far))return{distance:c,point:j0.clone().applyMatrix4(i.matrixWorld),index:o,face:null,faceIndex:null,barycoord:null,object:i}}var Q0=new R,eg=new R,ci=class extends Bi{constructor(e,t){super(e,t),this.isLineSegments=!0,this.type="LineSegments"}computeLineDistances(){let e=this.geometry;if(e.index===null){let t=e.attributes.position,n=[];for(let r=0,s=t.count;r<s;r+=2)Q0.fromBufferAttribute(t,r),eg.fromBufferAttribute(t,r+1),n[r]=r===0?0:n[r-1],n[r+1]=n[r]+Q0.distanceTo(eg);e.setAttribute("lineDistance",new Ve(n,1))}else Ge("LineSegments.computeLineDistances(): Computation only possible with non-indexed BufferGeometry.");return this}},Il=class extends Bi{constructor(e,t){super(e,t),this.isLineLoop=!0,this.type="LineLoop"}},Yo=class extends an{constructor(e){super(),this.isPointsMaterial=!0,this.type="PointsMaterial",this.color=new be(16777215),this.map=null,this.alphaMap=null,this.size=1,this.sizeAttenuation=!0,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.alphaMap=e.alphaMap,this.size=e.size,this.sizeAttenuation=e.sizeAttenuation,this.fog=e.fog,this}},tg=new it,gp=new Mr,ch=new on,uh=new R,Is=class extends At{constructor(e=new et,t=new Yo){super(),this.isPoints=!0,this.type="Points",this.geometry=e,this.material=t,this.morphTargetDictionary=void 0,this.morphTargetInfluences=void 0,this.updateMorphTargets()}copy(e,t){return super.copy(e,t),this.material=Array.isArray(e.material)?e.material.slice():e.material,this.geometry=e.geometry,this}intersectsFrustum(e){return e.intersectsObject(this)}raycast(e,t){let n=this.geometry,r=this.matrixWorld,s=e.params.Points.threshold,o=n.drawRange;if(n.boundingSphere===null&&n.computeBoundingSphere(),ch.copy(n.boundingSphere),ch.applyMatrix4(r),ch.radius+=s,e.ray.intersectsSphere(ch)===!1)return;tg.copy(r).invert(),gp.copy(e.ray).applyMatrix4(tg);let a=s/((this.scale.x+this.scale.y+this.scale.z)/3),l=a*a,c=n.index,f=n.attributes.position;if(c!==null){let h=Math.max(0,o.start),d=Math.min(c.count,o.start+o.count);for(let p=h,v=d;p<v;p++){let g=c.getX(p);uh.fromBufferAttribute(f,g),ng(uh,g,l,r,e,t,this)}}else{let h=Math.max(0,o.start),d=Math.min(f.count,o.start+o.count);for(let p=h,v=d;p<v;p++)uh.fromBufferAttribute(f,p),ng(uh,p,l,r,e,t,this)}}updateMorphTargets(){let t=this.geometry.morphAttributes,n=Object.keys(t);if(n.length>0){let r=t[n[0]];if(r!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let s=0,o=r.length;s<o;s++){let a=r[s].name||String(s);this.morphTargetInfluences.push(0),this.morphTargetDictionary[a]=s}}}}};function ng(i,e,t,n,r,s,o){let a=gp.distanceSqToPoint(i);if(a<t){let l=new R;gp.closestPointToPoint(i,l),l.applyMatrix4(n);let c=r.ray.origin.distanceTo(l);if(c<r.near||c>r.far)return;s.push({distance:c,distanceToRay:Math.sqrt(a),point:l,index:e,face:null,faceIndex:null,barycoord:null,object:o})}}var Ll=class extends jt{constructor(e,t,n,r,s=zt,o=zt,a,l,c){super(e,t,n,r,s,o,a,l,c),this.isVideoTexture=!0,this.generateMipmaps=!1,this._requestVideoFrameCallbackId=0;let u=this;function f(){u.needsUpdate=!0,u._requestVideoFrameCallbackId=e.requestVideoFrameCallback(f)}"requestVideoFrameCallback"in e&&(this._requestVideoFrameCallbackId=e.requestVideoFrameCallback(f))}clone(){return new this.constructor(this.image).copy(this)}update(){let e=this.image;"requestVideoFrameCallback"in e===!1&&e.readyState>=e.HAVE_CURRENT_DATA&&(this.needsUpdate=!0)}dispose(){this._requestVideoFrameCallbackId!==0&&(this.source.data.cancelVideoFrameCallback(this._requestVideoFrameCallbackId),this._requestVideoFrameCallbackId=0),super.dispose()}},zh=class extends Ll{constructor(e,t,n,r,s,o,a,l){super({},e,t,n,r,s,o,a,l),this.isVideoFrameTexture=!0}update(){}clone(){return new this.constructor().copy(this)}setFrame(e){this.image=e,this.needsUpdate=!0}},kh=class extends jt{constructor(e,t){super({width:e,height:t}),this.isFramebufferTexture=!0,this.magFilter=Kt,this.minFilter=Kt,this.generateMipmaps=!1,this.needsUpdate=!0}},Ls=class extends jt{constructor(e,t,n,r,s,o,a,l,c,u,f,h){super(null,o,a,l,c,u,r,s,f,h),this.isCompressedTexture=!0,this.image={width:t,height:n},this.mipmaps=e,this.flipY=!1,this.generateMipmaps=!1}},Gh=class extends Ls{constructor(e,t,n,r,s,o){super(e,t,n,s,o),this.isCompressedArrayTexture=!0,this.image.depth=r,this.wrapR=zn,this.layerUpdates=new Set}copy(e){return super.copy(e),this.wrapR=e.wrapR,this}addLayerUpdate(e){this.layerUpdates.add(e)}clearLayerUpdates(){this.layerUpdates.clear()}},Vh=class extends Ls{constructor(e,t,n){super(void 0,e[0].width,e[0].height,t,n,zi),this.isCompressedCubeTexture=!0,this.isCubeTexture=!0,this.image=e}},Kr=class extends jt{constructor(e=[],t=zi,n,r,s,o,a,l,c,u){super(e,t,n,r,s,o,a,l,c,u),this.isCubeTexture=!0,this.flipY=!1}get images(){return this.image}set images(e){this.image=e}},Zo=class extends jt{constructor(e,t,n,r,s,o,a,l,c){super(e,t,n,r,s,o,a,l,c),this.isCanvasTexture=!0,this.needsUpdate=!0}},Hh=class extends jt{constructor(e,t,n,r,s,o,a,l,c){super(e,t,n,r,s,o,a,l,c),this.isHTMLTexture=!0,this.generateMipmaps=!1,this.needsUpdate=!0;let u=e?e.parentNode:null;u!==null&&"requestPaint"in u&&(u.onpaint=()=>{this.needsUpdate=!0},u.requestPaint())}dispose(){let e=this.image?this.image.parentNode:null;e!==null&&"onpaint"in e&&(e.onpaint=null),super.dispose()}},Sr=class extends jt{constructor(e,t,n=hi,r,s,o,a=Kt,l=Kt,c,u=Ui,f=1){if(u!==Ui&&u!==Pr)throw new Error("THREE.DepthTexture: format must be either THREE.DepthFormat or THREE.DepthStencilFormat");let h={width:e,height:t,depth:f};super(h,r,s,o,a,l,u,n,c),this.isDepthTexture=!0,this.flipY=!1,this.generateMipmaps=!1,this.compareFunction=null}copy(e){return super.copy(e),this.source=new Si(Object.assign({},e.image)),this.compareFunction=e.compareFunction,this}toJSON(e){let t=super.toJSON(e);return t.compareFunction=this.compareFunction,t}},Dl=class extends Sr{constructor(e,t=hi,n=zi,r,s,o=Kt,a=Kt,l,c=Ui){let u={width:e,height:e,depth:1},f=[u,u,u,u,u,u];super(e,e,t,n,r,s,o,a,l,c),this.image=f,this.isCubeDepthTexture=!0,this.isCubeTexture=!0}get images(){return this.image}set images(e){this.image=e}},$o=class extends jt{constructor(e=null){super(),this.sourceTexture=e,this.isExternalTexture=!0}copy(e){return super.copy(e),this.sourceTexture=e.sourceTexture,this}},In=class i extends et{constructor(e=1,t=1,n=1,r=1,s=1,o=1){super(),this.type="BoxGeometry",this.parameters={width:e,height:t,depth:n,widthSegments:r,heightSegments:s,depthSegments:o};let a=this;r=Math.floor(r),s=Math.floor(s),o=Math.floor(o);let l=[],c=[],u=[],f=[],h=0,d=0;p("z","y","x",-1,-1,n,t,e,o,s,0),p("z","y","x",1,-1,n,t,-e,o,s,1),p("x","z","y",1,1,e,n,t,r,o,2),p("x","z","y",1,-1,e,n,-t,r,o,3),p("x","y","z",1,-1,e,t,n,r,s,4),p("x","y","z",-1,-1,e,t,-n,r,s,5),this.setIndex(l),this.setAttribute("position",new Ve(c,3)),this.setAttribute("normal",new Ve(u,3)),this.setAttribute("uv",new Ve(f,2));function p(v,g,m,y,_,x,S,b,E,M,T){let A=x/E,I=S/M,D=x/2,B=S/2,F=b/2,L=E+1,U=M+1,X=0,te=0,Z=new R;for(let K=0;K<U;K++){let j=K*I-B;for(let ne=0;ne<L;ne++){let ie=ne*A-D;Z[v]=ie*y,Z[g]=j*_,Z[m]=F,c.push(Z.x,Z.y,Z.z),Z[v]=0,Z[g]=0,Z[m]=b>0?1:-1,u.push(Z.x,Z.y,Z.z),f.push(ne/E),f.push(1-K/M),X+=1}}for(let K=0;K<M;K++)for(let j=0;j<E;j++){let ne=h+j+L*K,ie=h+j+L*(K+1),We=h+(j+1)+L*(K+1),Fe=h+(j+1)+L*K;l.push(ne,ie,Fe),l.push(ie,We,Fe),te+=6}a.addGroup(d,te,T),d+=te,h+=X}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new i(e.width,e.height,e.depth,e.widthSegments,e.heightSegments,e.depthSegments)}},Nl=class i extends et{constructor(e=1,t=1,n=4,r=8,s=1){super(),this.type="CapsuleGeometry",this.parameters={radius:e,height:t,capSegments:n,radialSegments:r,heightSegments:s},t=Math.max(0,t),n=Math.max(1,Math.floor(n)),r=Math.max(3,Math.floor(r)),s=Math.max(1,Math.floor(s));let o=[],a=[],l=[],c=[],u=t/2,f=Math.PI/2*e,h=t,d=2*f+h,p=n*2+s,v=r+1,g=new R,m=new R;for(let y=0;y<=p;y++){let _=0,x=0,S=0,b=0;if(y<=n){let T=y/n,A=T*Math.PI/2;x=-u-e*Math.cos(A),S=e*Math.sin(A),b=-e*Math.cos(A),_=T*f}else if(y<=n+s){let T=(y-n)/s;x=-u+T*t,S=e,b=0,_=f+T*h}else{let T=(y-n-s)/n,A=T*Math.PI/2;x=u+e*Math.sin(A),S=e*Math.cos(A),b=e*Math.sin(A),_=f+h+T*f}let E=Math.max(0,Math.min(1,_/d)),M=0;y===0?M=.5/r:y===p&&(M=-.5/r);for(let T=0;T<=r;T++){let A=T/r,I=A*Math.PI*2,D=Math.sin(I),B=Math.cos(I);m.x=-S*B,m.y=x,m.z=S*D,a.push(m.x,m.y,m.z),g.set(-S*B,b,S*D),g.normalize(),l.push(g.x,g.y,g.z),c.push(A+M,E)}if(y>0){let T=(y-1)*v;for(let A=0;A<r;A++){let I=T+A,D=T+A+1,B=y*v+A,F=y*v+A+1;o.push(I,D,B),o.push(D,F,B)}}}this.setIndex(o),this.setAttribute("position",new Ve(a,3)),this.setAttribute("normal",new Ve(l,3)),this.setAttribute("uv",new Ve(c,2))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new i(e.radius,e.height,e.capSegments,e.radialSegments,e.heightSegments)}},Ds=class i extends et{constructor(e=1,t=32,n=0,r=Math.PI*2){super(),this.type="CircleGeometry",this.parameters={radius:e,segments:t,thetaStart:n,thetaLength:r},t=Math.max(3,t);let s=[],o=[],a=[],l=[],c=new R,u=new he;o.push(0,0,0),a.push(0,0,1),l.push(.5,.5);for(let f=0,h=3;f<=t;f++,h+=3){let d=n+f/t*r;c.x=e*Math.cos(d),c.y=e*Math.sin(d),o.push(c.x,c.y,c.z),a.push(0,0,1),u.x=(o[h]/e+1)/2,u.y=(o[h+1]/e+1)/2,l.push(u.x,u.y)}for(let f=1;f<=t;f++)s.push(f,f+1,0);this.setIndex(s),this.setAttribute("position",new Ve(o,3)),this.setAttribute("normal",new Ve(a,3)),this.setAttribute("uv",new Ve(l,2))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new i(e.radius,e.segments,e.thetaStart,e.thetaLength)}},pn=class i extends et{constructor(e=1,t=1,n=1,r=32,s=1,o=!1,a=0,l=Math.PI*2){super(),this.type="CylinderGeometry",this.parameters={radiusTop:e,radiusBottom:t,height:n,radialSegments:r,heightSegments:s,openEnded:o,thetaStart:a,thetaLength:l};let c=this;r=Math.floor(r),s=Math.floor(s);let u=[],f=[],h=[],d=[],p=0,v=[],g=n/2,m=0;y(),o===!1&&(e>0&&_(!0),t>0&&_(!1)),this.setIndex(u),this.setAttribute("position",new Ve(f,3)),this.setAttribute("normal",new Ve(h,3)),this.setAttribute("uv",new Ve(d,2));function y(){let x=new R,S=new R,b=0,E=(t-e)/n;for(let M=0;M<=s;M++){let T=[],A=M/s,I=A*(t-e)+e;for(let D=0;D<=r;D++){let B=D/r,F=B*l+a,L=Math.sin(F),U=Math.cos(F);S.x=I*L,S.y=-A*n+g,S.z=I*U,f.push(S.x,S.y,S.z),x.set(L,E,U).normalize(),h.push(x.x,x.y,x.z),d.push(B,1-A),T.push(p++)}v.push(T)}for(let M=0;M<r;M++)for(let T=0;T<s;T++){let A=v[T][M],I=v[T+1][M],D=v[T+1][M+1],B=v[T][M+1];(e>0||T!==0)&&(u.push(A,I,B),b+=3),(t>0||T!==s-1)&&(u.push(I,D,B),b+=3)}c.addGroup(m,b,0),m+=b}function _(x){let S=p,b=new he,E=new R,M=0,T=x===!0?e:t,A=x===!0?1:-1;for(let D=1;D<=r;D++)f.push(0,g*A,0),h.push(0,A,0),d.push(.5,.5),p++;let I=p;for(let D=0;D<=r;D++){let F=D/r*l+a,L=Math.cos(F),U=Math.sin(F);E.x=T*U,E.y=g*A,E.z=T*L,f.push(E.x,E.y,E.z),h.push(0,A,0),b.x=L*.5+.5,b.y=U*.5*A+.5,d.push(b.x,b.y),p++}for(let D=0;D<r;D++){let B=S+D,F=I+D;x===!0?u.push(F,F+1,B):u.push(F+1,F,B),M+=3}c.addGroup(m,M,x===!0?1:2),m+=M}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new i(e.radiusTop,e.radiusBottom,e.height,e.radialSegments,e.heightSegments,e.openEnded,e.thetaStart,e.thetaLength)}},Qn=class i extends pn{constructor(e=1,t=1,n=32,r=1,s=!1,o=0,a=Math.PI*2){super(0,e,t,n,r,s,o,a),this.type="ConeGeometry",this.parameters={radius:e,height:t,radialSegments:n,heightSegments:r,openEnded:s,thetaStart:o,thetaLength:a}}static fromJSON(e){return new i(e.radius,e.height,e.radialSegments,e.heightSegments,e.openEnded,e.thetaStart,e.thetaLength)}},br=class i extends et{constructor(e=[],t=[],n=1,r=0){super(),this.type="PolyhedronGeometry",this.parameters={vertices:e,indices:t,radius:n,detail:r};let s=[],o=[];a(r),c(n),u(),this.setAttribute("position",new Ve(s,3)),this.setAttribute("normal",new Ve(s.slice(),3)),this.setAttribute("uv",new Ve(o,2)),r===0?this.computeVertexNormals():this.normalizeNormals();function a(y){let _=new R,x=new R,S=new R;for(let b=0;b<t.length;b+=3)d(t[b+0],_),d(t[b+1],x),d(t[b+2],S),l(_,x,S,y)}function l(y,_,x,S){let b=S+1,E=[];for(let M=0;M<=b;M++){E[M]=[];let T=y.clone().lerp(x,M/b),A=_.clone().lerp(x,M/b),I=b-M;for(let D=0;D<=I;D++)D===0&&M===b?E[M][D]=T:E[M][D]=T.clone().lerp(A,D/I)}for(let M=0;M<b;M++)for(let T=0;T<2*(b-M)-1;T++){let A=Math.floor(T/2);T%2===0?(h(E[M][A+1]),h(E[M+1][A]),h(E[M][A])):(h(E[M][A+1]),h(E[M+1][A+1]),h(E[M+1][A]))}}function c(y){let _=new R;for(let x=0;x<s.length;x+=3)_.x=s[x+0],_.y=s[x+1],_.z=s[x+2],_.normalize().multiplyScalar(y),s[x+0]=_.x,s[x+1]=_.y,s[x+2]=_.z}function u(){let y=new R;for(let _=0;_<s.length;_+=3){y.x=s[_+0],y.y=s[_+1],y.z=s[_+2];let x=g(y)/2/Math.PI+.5,S=m(y)/Math.PI+.5;o.push(x,1-S)}p(),f()}function f(){for(let y=0;y<o.length;y+=6){let _=o[y+0],x=o[y+2],S=o[y+4],b=Math.max(_,x,S),E=Math.min(_,x,S);b>.9&&E<.1&&(_<.2&&(o[y+0]+=1),x<.2&&(o[y+2]+=1),S<.2&&(o[y+4]+=1))}}function h(y){s.push(y.x,y.y,y.z)}function d(y,_){let x=y*3;_.x=e[x+0],_.y=e[x+1],_.z=e[x+2]}function p(){let y=new R,_=new R,x=new R,S=new R,b=new he,E=new he,M=new he;for(let T=0,A=0;T<s.length;T+=9,A+=6){y.set(s[T+0],s[T+1],s[T+2]),_.set(s[T+3],s[T+4],s[T+5]),x.set(s[T+6],s[T+7],s[T+8]),b.set(o[A+0],o[A+1]),E.set(o[A+2],o[A+3]),M.set(o[A+4],o[A+5]),S.copy(y).add(_).add(x).divideScalar(3);let I=g(S);v(b,A+0,y,I),v(E,A+2,_,I),v(M,A+4,x,I)}}function v(y,_,x,S){S<0&&y.x===1&&(o[_]=y.x-1),x.x===0&&x.z===0&&(o[_]=S/2/Math.PI+.5)}function g(y){return Math.atan2(y.z,-y.x)}function m(y){return Math.atan2(-y.y,Math.sqrt(y.x*y.x+y.z*y.z))}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new i(e.vertices,e.indices,e.radius,e.detail)}},Ns=class i extends br{constructor(e=1,t=0){let n=(1+Math.sqrt(5))/2,r=1/n,s=[-1,-1,-1,-1,-1,1,-1,1,-1,-1,1,1,1,-1,-1,1,-1,1,1,1,-1,1,1,1,0,-r,-n,0,-r,n,0,r,-n,0,r,n,-r,-n,0,-r,n,0,r,-n,0,r,n,0,-n,0,-r,n,0,-r,-n,0,r,n,0,r],o=[3,11,7,3,7,15,3,15,13,7,19,17,7,17,6,7,6,15,17,4,8,17,8,10,17,10,6,8,0,16,8,16,2,8,2,10,0,12,1,0,1,18,0,18,16,6,10,2,6,2,13,6,13,15,2,16,18,2,18,3,2,3,13,18,1,9,18,9,11,18,11,3,4,14,12,4,12,0,4,0,8,11,9,5,11,5,19,11,19,7,19,5,14,19,14,4,19,4,17,1,12,14,1,14,5,1,5,9];super(s,o,e,t),this.type="DodecahedronGeometry",this.parameters={radius:e,detail:t}}static fromJSON(e){return new i(e.radius,e.detail)}},hh=new R,fh=new R,rp=new R,dh=new Ni,Fl=class extends et{constructor(e=null,t=1){if(super(),this.type="EdgesGeometry",this.parameters={geometry:e,thresholdAngle:t},e!==null){let r=Math.pow(10,4),s=Math.cos(bs*t),o=e.getIndex(),a=e.getAttribute("position"),l=o?o.count:a.count,c=[0,0,0],u=["a","b","c"],f=new Array(3),h={},d=[];for(let p=0;p<l;p+=3){o?(c[0]=o.getX(p),c[1]=o.getX(p+1),c[2]=o.getX(p+2)):(c[0]=p,c[1]=p+1,c[2]=p+2);let{a:v,b:g,c:m}=dh;if(v.fromBufferAttribute(a,c[0]),g.fromBufferAttribute(a,c[1]),m.fromBufferAttribute(a,c[2]),dh.getNormal(rp),f[0]=`${Math.round(v.x*r)},${Math.round(v.y*r)},${Math.round(v.z*r)}`,f[1]=`${Math.round(g.x*r)},${Math.round(g.y*r)},${Math.round(g.z*r)}`,f[2]=`${Math.round(m.x*r)},${Math.round(m.y*r)},${Math.round(m.z*r)}`,!(f[0]===f[1]||f[1]===f[2]||f[2]===f[0]))for(let y=0;y<3;y++){let _=(y+1)%3,x=f[y],S=f[_],b=dh[u[y]],E=dh[u[_]],M=`${x}_${S}`,T=`${S}_${x}`;T in h&&h[T]?(rp.dot(h[T].normal)<=s&&(d.push(b.x,b.y,b.z),d.push(E.x,E.y,E.z)),h[T]=null):M in h||(h[M]={index0:c[y],index1:c[_],normal:rp.clone()})}}for(let p in h)if(h[p]){let{index0:v,index1:g}=h[p];hh.fromBufferAttribute(a,v),fh.fromBufferAttribute(a,g),d.push(hh.x,hh.y,hh.z),d.push(fh.x,fh.y,fh.z)}this.setAttribute("position",new Ve(d,3))}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}},ei=class{constructor(){this.type="Curve",this.arcLengthDivisions=200,this.needsUpdate=!1,this.cacheArcLengths=null}getPoint(){Ge("Curve: .getPoint() not implemented.")}getPointAt(e,t){let n=this.getUtoTmapping(e);return this.getPoint(n,t)}getPoints(e=5){let t=[];for(let n=0;n<=e;n++)t.push(this.getPoint(n/e));return t}getSpacedPoints(e=5){let t=[];for(let n=0;n<=e;n++)t.push(this.getPointAt(n/e));return t}getLength(){let e=this.getLengths();return e[e.length-1]}getLengths(e=this.arcLengthDivisions){if(this.cacheArcLengths&&this.cacheArcLengths.length===e+1&&!this.needsUpdate)return this.cacheArcLengths;this.needsUpdate=!1;let t=[],n,r=this.getPoint(0),s=0;t.push(0);for(let o=1;o<=e;o++)n=this.getPoint(o/e),s+=n.distanceTo(r),t.push(s),r=n;return this.cacheArcLengths=t,t}updateArcLengths(){this.needsUpdate=!0,this.getLengths()}getUtoTmapping(e,t=null){let n=this.getLengths(),r=0,s=n.length,o;t?o=t:o=e*n[s-1];let a=0,l=s-1,c;for(;a<=l;)if(r=Math.floor(a+(l-a)/2),c=n[r]-o,c<0)a=r+1;else if(c>0)l=r-1;else{l=r;break}if(r=l,n[r]===o)return r/(s-1);let u=n[r],h=n[r+1]-u,d=(o-u)/h;return(r+d)/(s-1)}getTangent(e,t){let r=e-1e-4,s=e+1e-4;r<0&&(r=0),s>1&&(s=1);let o=this.getPoint(r),a=this.getPoint(s),l=t||(o.isVector2?new he:new R);return l.copy(a).sub(o).normalize(),l}getTangentAt(e,t){let n=this.getUtoTmapping(e);return this.getTangent(n,t)}computeFrenetFrames(e,t=!1){let n=new R,r=[],s=[],o=[],a=new R,l=new it;for(let d=0;d<=e;d++){let p=d/e;r[d]=this.getTangentAt(p,new R)}s[0]=new R,o[0]=new R;let c=Number.MAX_VALUE,u=Math.abs(r[0].x),f=Math.abs(r[0].y),h=Math.abs(r[0].z);u<=c&&(c=u,n.set(1,0,0)),f<=c&&(c=f,n.set(0,1,0)),h<=c&&n.set(0,0,1),a.crossVectors(r[0],n).normalize(),s[0].crossVectors(r[0],a),o[0].crossVectors(r[0],s[0]);for(let d=1;d<=e;d++){if(s[d]=s[d-1].clone(),o[d]=o[d-1].clone(),a.crossVectors(r[d-1],r[d]),a.length()>Number.EPSILON){a.normalize();let p=Math.acos(ot(r[d-1].dot(r[d]),-1,1));s[d].applyMatrix4(l.makeRotationAxis(a,p))}o[d].crossVectors(r[d],s[d])}if(t===!0){let d=Math.acos(ot(s[0].dot(s[e]),-1,1));d/=e,r[0].dot(a.crossVectors(s[0],s[e]))>0&&(d=-d);for(let p=1;p<=e;p++)s[p].applyMatrix4(l.makeRotationAxis(r[p],d*p)),o[p].crossVectors(r[p],s[p])}return{tangents:r,normals:s,binormals:o}}clone(){return new this.constructor().copy(this)}copy(e){return this.arcLengthDivisions=e.arcLengthDivisions,this}toJSON(){let e={metadata:{version:4.7,type:"Curve",generator:"Curve.toJSON"}};return e.arcLengthDivisions=this.arcLengthDivisions,e.type=this.type,e}fromJSON(e){return this.arcLengthDivisions=e.arcLengthDivisions,this}},Fs=class extends ei{constructor(e=0,t=0,n=1,r=1,s=0,o=Math.PI*2,a=!1,l=0){super(),this.isEllipseCurve=!0,this.type="EllipseCurve",this.aX=e,this.aY=t,this.xRadius=n,this.yRadius=r,this.aStartAngle=s,this.aEndAngle=o,this.aClockwise=a,this.aRotation=l}getPoint(e,t=new he){let n=t,r=Math.PI*2,s=this.aEndAngle-this.aStartAngle,o=Math.abs(s)<Number.EPSILON;for(;s<0;)s+=r;for(;s>r;)s-=r;s<Number.EPSILON&&(o?s=0:s=r),this.aClockwise===!0&&!o&&(s===r?s=-r:s=s-r);let a=this.aStartAngle+e*s,l=this.aX+this.xRadius*Math.cos(a),c=this.aY+this.yRadius*Math.sin(a);if(this.aRotation!==0){let u=Math.cos(this.aRotation),f=Math.sin(this.aRotation),h=l-this.aX,d=c-this.aY;l=h*u-d*f+this.aX,c=h*f+d*u+this.aY}return n.set(l,c)}copy(e){return super.copy(e),this.aX=e.aX,this.aY=e.aY,this.xRadius=e.xRadius,this.yRadius=e.yRadius,this.aStartAngle=e.aStartAngle,this.aEndAngle=e.aEndAngle,this.aClockwise=e.aClockwise,this.aRotation=e.aRotation,this}toJSON(){let e=super.toJSON();return e.aX=this.aX,e.aY=this.aY,e.xRadius=this.xRadius,e.yRadius=this.yRadius,e.aStartAngle=this.aStartAngle,e.aEndAngle=this.aEndAngle,e.aClockwise=this.aClockwise,e.aRotation=this.aRotation,e}fromJSON(e){return super.fromJSON(e),this.aX=e.aX,this.aY=e.aY,this.xRadius=e.xRadius,this.yRadius=e.yRadius,this.aStartAngle=e.aStartAngle,this.aEndAngle=e.aEndAngle,this.aClockwise=e.aClockwise,this.aRotation=e.aRotation,this}},Ul=class extends Fs{constructor(e,t,n,r,s,o){super(e,t,n,n,r,s,o),this.isArcCurve=!0,this.type="ArcCurve"}};function mm(){let i=0,e=0,t=0,n=0;function r(s,o,a,l){i=s,e=a,t=-3*s+3*o-2*a-l,n=2*s-2*o+a+l}return{initCatmullRom:function(s,o,a,l,c){r(o,a,c*(a-s),c*(l-o))},initNonuniformCatmullRom:function(s,o,a,l,c,u,f){let h=(o-s)/c-(a-s)/(c+u)+(a-o)/u,d=(a-o)/u-(l-o)/(u+f)+(l-a)/f;h*=u,d*=u,r(o,a,h,d)},calc:function(s){let o=s*s,a=o*s;return i+e*s+t*o+n*a}}}var ig=new R,rg=new R,sp=new mm,op=new mm,ap=new mm,Us=class extends ei{constructor(e=[],t=!1,n="centripetal",r=.5){super(),this.isCatmullRomCurve3=!0,this.type="CatmullRomCurve3",this.points=e,this.closed=t,this.curveType=n,this.tension=r}getPoint(e,t=new R){let n=t,r=this.points,s=r.length,o=(s-(this.closed?0:1))*e,a=Math.floor(o),l=o-a;this.closed?a+=a>0?0:(Math.floor(Math.abs(a)/s)+1)*s:l===0&&a===s-1&&(a=s-2,l=1);let c,u;this.closed||a>0?c=r[(a-1)%s]:(rg.subVectors(r[0],r[1]).add(r[0]),c=rg);let f=r[a%s],h=r[(a+1)%s];if(this.closed||a+2<s?u=r[(a+2)%s]:(ig.subVectors(r[s-1],r[s-2]).add(r[s-1]),u=ig),this.curveType==="centripetal"||this.curveType==="chordal"){let d=this.curveType==="chordal"?.5:.25,p=Math.pow(c.distanceToSquared(f),d),v=Math.pow(f.distanceToSquared(h),d),g=Math.pow(h.distanceToSquared(u),d);v<1e-4&&(v=1),p<1e-4&&(p=v),g<1e-4&&(g=v),sp.initNonuniformCatmullRom(c.x,f.x,h.x,u.x,p,v,g),op.initNonuniformCatmullRom(c.y,f.y,h.y,u.y,p,v,g),ap.initNonuniformCatmullRom(c.z,f.z,h.z,u.z,p,v,g)}else this.curveType==="catmullrom"&&(sp.initCatmullRom(c.x,f.x,h.x,u.x,this.tension),op.initCatmullRom(c.y,f.y,h.y,u.y,this.tension),ap.initCatmullRom(c.z,f.z,h.z,u.z,this.tension));return n.set(sp.calc(l),op.calc(l),ap.calc(l)),n}copy(e){super.copy(e),this.points=[];for(let t=0,n=e.points.length;t<n;t++){let r=e.points[t];this.points.push(r.clone())}return this.closed=e.closed,this.curveType=e.curveType,this.tension=e.tension,this}toJSON(){let e=super.toJSON();e.points=[];for(let t=0,n=this.points.length;t<n;t++){let r=this.points[t];e.points.push(r.toArray())}return e.closed=this.closed,e.curveType=this.curveType,e.tension=this.tension,e}fromJSON(e){super.fromJSON(e),this.points=[];for(let t=0,n=e.points.length;t<n;t++){let r=e.points[t];this.points.push(new R().fromArray(r))}return this.closed=e.closed,this.curveType=e.curveType,this.tension=e.tension,this}};function sg(i,e,t,n,r){let s=(n-e)*.5,o=(r-t)*.5,a=i*i,l=i*a;return(2*t-2*n+s+o)*l+(-3*t+3*n-2*s-o)*a+s*i+t}function A_(i,e){let t=1-i;return t*t*e}function E_(i,e){return 2*(1-i)*i*e}function C_(i,e){return i*i*e}function fl(i,e,t,n){return A_(i,e)+E_(i,t)+C_(i,n)}function R_(i,e){let t=1-i;return t*t*t*e}function P_(i,e){let t=1-i;return 3*t*t*i*e}function I_(i,e){return 3*(1-i)*i*i*e}function L_(i,e){return i*i*i*e}function dl(i,e,t,n,r){return R_(i,e)+P_(i,t)+I_(i,n)+L_(i,r)}var Jo=class extends ei{constructor(e=new he,t=new he,n=new he,r=new he){super(),this.isCubicBezierCurve=!0,this.type="CubicBezierCurve",this.v0=e,this.v1=t,this.v2=n,this.v3=r}getPoint(e,t=new he){let n=t,r=this.v0,s=this.v1,o=this.v2,a=this.v3;return n.set(dl(e,r.x,s.x,o.x,a.x),dl(e,r.y,s.y,o.y,a.y)),n}copy(e){return super.copy(e),this.v0.copy(e.v0),this.v1.copy(e.v1),this.v2.copy(e.v2),this.v3.copy(e.v3),this}toJSON(){let e=super.toJSON();return e.v0=this.v0.toArray(),e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e.v3=this.v3.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v0.fromArray(e.v0),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this.v3.fromArray(e.v3),this}},Bl=class extends ei{constructor(e=new R,t=new R,n=new R,r=new R){super(),this.isCubicBezierCurve3=!0,this.type="CubicBezierCurve3",this.v0=e,this.v1=t,this.v2=n,this.v3=r}getPoint(e,t=new R){let n=t,r=this.v0,s=this.v1,o=this.v2,a=this.v3;return n.set(dl(e,r.x,s.x,o.x,a.x),dl(e,r.y,s.y,o.y,a.y),dl(e,r.z,s.z,o.z,a.z)),n}copy(e){return super.copy(e),this.v0.copy(e.v0),this.v1.copy(e.v1),this.v2.copy(e.v2),this.v3.copy(e.v3),this}toJSON(){let e=super.toJSON();return e.v0=this.v0.toArray(),e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e.v3=this.v3.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v0.fromArray(e.v0),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this.v3.fromArray(e.v3),this}},Ko=class extends ei{constructor(e=new he,t=new he){super(),this.isLineCurve=!0,this.type="LineCurve",this.v1=e,this.v2=t}getPoint(e,t=new he){let n=t;return e===1?n.copy(this.v2):(n.copy(this.v2).sub(this.v1),n.multiplyScalar(e).add(this.v1)),n}getPointAt(e,t){return this.getPoint(e,t)}getTangent(e,t=new he){return t.subVectors(this.v2,this.v1).normalize()}getTangentAt(e,t){return this.getTangent(e,t)}copy(e){return super.copy(e),this.v1.copy(e.v1),this.v2.copy(e.v2),this}toJSON(){let e=super.toJSON();return e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this}},Ol=class extends ei{constructor(e=new R,t=new R){super(),this.isLineCurve3=!0,this.type="LineCurve3",this.v1=e,this.v2=t}getPoint(e,t=new R){let n=t;return e===1?n.copy(this.v2):(n.copy(this.v2).sub(this.v1),n.multiplyScalar(e).add(this.v1)),n}getPointAt(e,t){return this.getPoint(e,t)}getTangent(e,t=new R){return t.subVectors(this.v2,this.v1).normalize()}getTangentAt(e,t){return this.getTangent(e,t)}copy(e){return super.copy(e),this.v1.copy(e.v1),this.v2.copy(e.v2),this}toJSON(){let e=super.toJSON();return e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this}},jo=class extends ei{constructor(e=new he,t=new he,n=new he){super(),this.isQuadraticBezierCurve=!0,this.type="QuadraticBezierCurve",this.v0=e,this.v1=t,this.v2=n}getPoint(e,t=new he){let n=t,r=this.v0,s=this.v1,o=this.v2;return n.set(fl(e,r.x,s.x,o.x),fl(e,r.y,s.y,o.y)),n}copy(e){return super.copy(e),this.v0.copy(e.v0),this.v1.copy(e.v1),this.v2.copy(e.v2),this}toJSON(){let e=super.toJSON();return e.v0=this.v0.toArray(),e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v0.fromArray(e.v0),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this}},Qo=class extends ei{constructor(e=new R,t=new R,n=new R){super(),this.isQuadraticBezierCurve3=!0,this.type="QuadraticBezierCurve3",this.v0=e,this.v1=t,this.v2=n}getPoint(e,t=new R){let n=t,r=this.v0,s=this.v1,o=this.v2;return n.set(fl(e,r.x,s.x,o.x),fl(e,r.y,s.y,o.y),fl(e,r.z,s.z,o.z)),n}copy(e){return super.copy(e),this.v0.copy(e.v0),this.v1.copy(e.v1),this.v2.copy(e.v2),this}toJSON(){let e=super.toJSON();return e.v0=this.v0.toArray(),e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v0.fromArray(e.v0),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this}},ea=class extends ei{constructor(e=[]){super(),this.isSplineCurve=!0,this.type="SplineCurve",this.points=e}getPoint(e,t=new he){let n=t,r=this.points,s=(r.length-1)*e,o=Math.floor(s),a=s-o,l=r[o===0?o:o-1],c=r[o],u=r[o>r.length-2?r.length-1:o+1],f=r[o>r.length-3?r.length-1:o+2];return n.set(sg(a,l.x,c.x,u.x,f.x),sg(a,l.y,c.y,u.y,f.y)),n}copy(e){super.copy(e),this.points=[];for(let t=0,n=e.points.length;t<n;t++){let r=e.points[t];this.points.push(r.clone())}return this}toJSON(){let e=super.toJSON();e.points=[];for(let t=0,n=this.points.length;t<n;t++){let r=this.points[t];e.points.push(r.toArray())}return e}fromJSON(e){super.fromJSON(e),this.points=[];for(let t=0,n=e.points.length;t<n;t++){let r=e.points[t];this.points.push(new he().fromArray(r))}return this}},Wh=Object.freeze({__proto__:null,ArcCurve:Ul,CatmullRomCurve3:Us,CubicBezierCurve:Jo,CubicBezierCurve3:Bl,EllipseCurve:Fs,LineCurve:Ko,LineCurve3:Ol,QuadraticBezierCurve:jo,QuadraticBezierCurve3:Qo,SplineCurve:ea}),zl=class extends ei{constructor(){super(),this.type="CurvePath",this.curves=[],this.autoClose=!1}add(e){this.curves.push(e)}closePath(){let e=this.curves[0].getPoint(0),t=this.curves[this.curves.length-1].getPoint(1);if(!e.equals(t)){let n=e.isVector2===!0?"LineCurve":"LineCurve3";this.curves.push(new Wh[n](t,e))}return this}getPoint(e,t){let n=e*this.getLength(),r=this.getCurveLengths(),s=0;for(;s<r.length;){if(r[s]>=n){let o=r[s]-n,a=this.curves[s],l=a.getLength(),c=l===0?0:1-o/l;return a.getPointAt(c,t)}s++}return null}getLength(){let e=this.getCurveLengths();return e[e.length-1]}updateArcLengths(){this.needsUpdate=!0,this.cacheLengths=null,this.getCurveLengths()}getCurveLengths(){if(this.cacheLengths&&this.cacheLengths.length===this.curves.length)return this.cacheLengths;let e=[],t=0;for(let n=0,r=this.curves.length;n<r;n++)t+=this.curves[n].getLength(),e.push(t);return this.cacheLengths=e,e}getSpacedPoints(e=40){let t=[];for(let n=0;n<=e;n++)t.push(this.getPoint(n/e));return this.autoClose&&t.push(t[0]),t}getPoints(e=12){let t=[],n;for(let r=0,s=this.curves;r<s.length;r++){let o=s[r],a=o.isEllipseCurve?e*2:o.isLineCurve||o.isLineCurve3?1:o.isSplineCurve?e*o.points.length:e,l=o.getPoints(a);for(let c=0;c<l.length;c++){let u=l[c];n&&n.equals(u)||(t.push(u),n=u)}}return this.autoClose&&t.length>1&&!t[t.length-1].equals(t[0])&&t.push(t[0]),t}copy(e){super.copy(e),this.curves=[];for(let t=0,n=e.curves.length;t<n;t++){let r=e.curves[t];this.curves.push(r.clone())}return this.autoClose=e.autoClose,this}toJSON(){let e=super.toJSON();e.autoClose=this.autoClose,e.curves=[];for(let t=0,n=this.curves.length;t<n;t++){let r=this.curves[t];e.curves.push(r.toJSON())}return e}fromJSON(e){super.fromJSON(e),this.autoClose=e.autoClose,this.curves=[];for(let t=0,n=e.curves.length;t<n;t++){let r=e.curves[t];this.curves.push(new Wh[r.type]().fromJSON(r))}return this}},jr=class extends zl{constructor(e){super(),this.type="Path",this.currentPoint=new he,e&&this.setFromPoints(e)}setFromPoints(e){this.moveTo(e[0].x,e[0].y);for(let t=1,n=e.length;t<n;t++)this.lineTo(e[t].x,e[t].y);return this}moveTo(e,t){return this.currentPoint.set(e,t),this}lineTo(e,t){let n=new Ko(this.currentPoint.clone(),new he(e,t));return this.curves.push(n),this.currentPoint.set(e,t),this}quadraticCurveTo(e,t,n,r){let s=new jo(this.currentPoint.clone(),new he(e,t),new he(n,r));return this.curves.push(s),this.currentPoint.set(n,r),this}bezierCurveTo(e,t,n,r,s,o){let a=new Jo(this.currentPoint.clone(),new he(e,t),new he(n,r),new he(s,o));return this.curves.push(a),this.currentPoint.set(s,o),this}splineThru(e){let t=[this.currentPoint.clone()].concat(e),n=new ea(t);return this.curves.push(n),this.currentPoint.copy(e[e.length-1]),this}arc(e,t,n,r,s,o){let a=this.currentPoint.x,l=this.currentPoint.y;return this.absarc(e+a,t+l,n,r,s,o),this}absarc(e,t,n,r,s,o){return this.absellipse(e,t,n,n,r,s,o),this}ellipse(e,t,n,r,s,o,a,l){let c=this.currentPoint.x,u=this.currentPoint.y;return this.absellipse(e+c,t+u,n,r,s,o,a,l),this}absellipse(e,t,n,r,s,o,a,l){let c=new Fs(e,t,n,r,s,o,a,l);if(this.curves.length>0){let f=c.getPoint(0);f.equals(this.currentPoint)||this.lineTo(f.x,f.y)}this.curves.push(c);let u=c.getPoint(1);return this.currentPoint.copy(u),this}copy(e){return super.copy(e),this.currentPoint.copy(e.currentPoint),this}toJSON(){let e=super.toJSON();return e.currentPoint=this.currentPoint.toArray(),e}fromJSON(e){return super.fromJSON(e),this.currentPoint.fromArray(e.currentPoint),this}},Ti=class extends jr{constructor(e){super(e),this.uuid=ai(),this.type="Shape",this.holes=[]}getPointsHoles(e){let t=[];for(let n=0,r=this.holes.length;n<r;n++)t[n]=this.holes[n].getPoints(e);return t}extractPoints(e){return{shape:this.getPoints(e),holes:this.getPointsHoles(e)}}copy(e){super.copy(e),this.holes=[];for(let t=0,n=e.holes.length;t<n;t++){let r=e.holes[t];this.holes.push(r.clone())}return this}toJSON(){let e=super.toJSON();e.uuid=this.uuid,e.holes=[];for(let t=0,n=this.holes.length;t<n;t++){let r=this.holes[t];e.holes.push(r.toJSON())}return e}fromJSON(e){super.fromJSON(e),this.uuid=e.uuid,this.holes=[];for(let t=0,n=e.holes.length;t<n;t++){let r=e.holes[t];this.holes.push(new jr().fromJSON(r))}return this}};function D_(i,e,t=2){let n=e&&e.length,r=n?e[0]*t:i.length,s=Iv(i,0,r,t,!0),o=[];if(!s||s.next===s.prev)return o;let a,l,c;if(n&&(s=O_(i,e,s,t)),i.length>80*t){a=i[0],l=i[1];let u=a,f=l;for(let h=t;h<r;h+=t){let d=i[h],p=i[h+1];d<a&&(a=d),p<l&&(l=p),d>u&&(u=d),p>f&&(f=p)}c=Math.max(u-a,f-l),c=c!==0?32767/c:0}return kl(s,o,t,a,l,c,0),o}function Iv(i,e,t,n,r){let s;if(r===$_(i,e,t,n)>0)for(let o=e;o<t;o+=n)s=og(o/n|0,i[o],i[o+1],s);else for(let o=t-n;o>=e;o-=n)s=og(o/n|0,i[o],i[o+1],s);return s&&ta(s,s.next)&&(Vl(s),s=s.next),s}function Bs(i,e){if(!i)return i;e||(e=i);let t=i,n;do if(n=!1,!t.steiner&&(ta(t,t.next)||Yt(t.prev,t,t.next)===0)){if(Vl(t),t=e=t.prev,t===t.next)break;n=!0}else t=t.next;while(n||t!==e);return e}function kl(i,e,t,n,r,s,o){if(!i)return;!o&&s&&H_(i,n,r,s);let a=i;for(;i.prev!==i.next;){let l=i.prev,c=i.next;if(s?F_(i,n,r,s):N_(i)){e.push(l.i,i.i,c.i),Vl(i),i=c.next,a=c.next;continue}if(i=c,i===a){o?o===1?(i=U_(Bs(i),e),kl(i,e,t,n,r,s,2)):o===2&&B_(i,e,t,n,r,s):kl(Bs(i),e,t,n,r,s,1);break}}}function N_(i){let e=i.prev,t=i,n=i.next;if(Yt(e,t,n)>=0)return!1;let r=e.x,s=t.x,o=n.x,a=e.y,l=t.y,c=n.y,u=Math.min(r,s,o),f=Math.min(a,l,c),h=Math.max(r,s,o),d=Math.max(a,l,c),p=n.next;for(;p!==e;){if(p.x>=u&&p.x<=h&&p.y>=f&&p.y<=d&&ll(r,a,s,l,o,c,p.x,p.y)&&Yt(p.prev,p,p.next)>=0)return!1;p=p.next}return!0}function F_(i,e,t,n){let r=i.prev,s=i,o=i.next;if(Yt(r,s,o)>=0)return!1;let a=r.x,l=s.x,c=o.x,u=r.y,f=s.y,h=o.y,d=Math.min(a,l,c),p=Math.min(u,f,h),v=Math.max(a,l,c),g=Math.max(u,f,h),m=vp(d,p,e,t,n),y=vp(v,g,e,t,n),_=i.prevZ,x=i.nextZ;for(;_&&_.z>=m&&x&&x.z<=y;){if(_.x>=d&&_.x<=v&&_.y>=p&&_.y<=g&&_!==r&&_!==o&&ll(a,u,l,f,c,h,_.x,_.y)&&Yt(_.prev,_,_.next)>=0||(_=_.prevZ,x.x>=d&&x.x<=v&&x.y>=p&&x.y<=g&&x!==r&&x!==o&&ll(a,u,l,f,c,h,x.x,x.y)&&Yt(x.prev,x,x.next)>=0))return!1;x=x.nextZ}for(;_&&_.z>=m;){if(_.x>=d&&_.x<=v&&_.y>=p&&_.y<=g&&_!==r&&_!==o&&ll(a,u,l,f,c,h,_.x,_.y)&&Yt(_.prev,_,_.next)>=0)return!1;_=_.prevZ}for(;x&&x.z<=y;){if(x.x>=d&&x.x<=v&&x.y>=p&&x.y<=g&&x!==r&&x!==o&&ll(a,u,l,f,c,h,x.x,x.y)&&Yt(x.prev,x,x.next)>=0)return!1;x=x.nextZ}return!0}function U_(i,e){let t=i;do{let n=t.prev,r=t.next.next;!ta(n,r)&&Dv(n,t,t.next,r)&&Gl(n,r)&&Gl(r,n)&&(e.push(n.i,t.i,r.i),Vl(t),Vl(t.next),t=i=r),t=t.next}while(t!==i);return Bs(t)}function B_(i,e,t,n,r,s){let o=i;do{let a=o.next.next;for(;a!==o.prev;){if(o.i!==a.i&&q_(o,a)){let l=Nv(o,a);o=Bs(o,o.next),l=Bs(l,l.next),kl(o,e,t,n,r,s,0),kl(l,e,t,n,r,s,0);return}a=a.next}o=o.next}while(o!==i)}function O_(i,e,t,n){let r=[];for(let s=0,o=e.length;s<o;s++){let a=e[s]*n,l=s<o-1?e[s+1]*n:i.length,c=Iv(i,a,l,n,!1);c===c.next&&(c.steiner=!0),r.push(X_(c))}r.sort(z_);for(let s=0;s<r.length;s++)t=k_(r[s],t);return t}function z_(i,e){let t=i.x-e.x;if(t===0&&(t=i.y-e.y,t===0)){let n=(i.next.y-i.y)/(i.next.x-i.x),r=(e.next.y-e.y)/(e.next.x-e.x);t=n-r}return t}function k_(i,e){let t=G_(i,e);if(!t)return e;let n=Nv(t,i);return Bs(n,n.next),Bs(t,t.next)}function G_(i,e){let t=e,n=i.x,r=i.y,s=-1/0,o;if(ta(i,t))return t;do{if(ta(i,t.next))return t.next;if(r<=t.y&&r>=t.next.y&&t.next.y!==t.y){let f=t.x+(r-t.y)*(t.next.x-t.x)/(t.next.y-t.y);if(f<=n&&f>s&&(s=f,o=t.x<t.next.x?t:t.next,f===n))return o}t=t.next}while(t!==e);if(!o)return null;let a=o,l=o.x,c=o.y,u=1/0;t=o;do{if(n>=t.x&&t.x>=l&&n!==t.x&&Lv(r<c?n:s,r,l,c,r<c?s:n,r,t.x,t.y)){let f=Math.abs(r-t.y)/(n-t.x);Gl(t,i)&&(f<u||f===u&&(t.x>o.x||t.x===o.x&&V_(o,t)))&&(o=t,u=f)}t=t.next}while(t!==a);return o}function V_(i,e){return Yt(i.prev,i,e.prev)<0&&Yt(e.next,i,i.next)<0}function H_(i,e,t,n){let r=i;do r.z===0&&(r.z=vp(r.x,r.y,e,t,n)),r.prevZ=r.prev,r.nextZ=r.next,r=r.next;while(r!==i);r.prevZ.nextZ=null,r.prevZ=null,W_(r)}function W_(i){let e,t=1;do{let n=i,r;i=null;let s=null;for(e=0;n;){e++;let o=n,a=0;for(let c=0;c<t&&(a++,o=o.nextZ,!!o);c++);let l=t;for(;a>0||l>0&&o;)a!==0&&(l===0||!o||n.z<=o.z)?(r=n,n=n.nextZ,a--):(r=o,o=o.nextZ,l--),s?s.nextZ=r:i=r,r.prevZ=s,s=r;n=o}s.nextZ=null,t*=2}while(e>1);return i}function vp(i,e,t,n,r){return i=(i-t)*r|0,e=(e-n)*r|0,i=(i|i<<8)&16711935,i=(i|i<<4)&252645135,i=(i|i<<2)&858993459,i=(i|i<<1)&1431655765,e=(e|e<<8)&16711935,e=(e|e<<4)&252645135,e=(e|e<<2)&858993459,e=(e|e<<1)&1431655765,i|e<<1}function X_(i){let e=i,t=i;do(e.x<t.x||e.x===t.x&&e.y<t.y)&&(t=e),e=e.next;while(e!==i);return t}function Lv(i,e,t,n,r,s,o,a){return(r-o)*(e-a)>=(i-o)*(s-a)&&(i-o)*(n-a)>=(t-o)*(e-a)&&(t-o)*(s-a)>=(r-o)*(n-a)}function ll(i,e,t,n,r,s,o,a){return!(i===o&&e===a)&&Lv(i,e,t,n,r,s,o,a)}function q_(i,e){return i.next.i!==e.i&&i.prev.i!==e.i&&!Y_(i,e)&&(Gl(i,e)&&Gl(e,i)&&Z_(i,e)&&(Yt(i.prev,i,e.prev)||Yt(i,e.prev,e))||ta(i,e)&&Yt(i.prev,i,i.next)>0&&Yt(e.prev,e,e.next)>0)}function Yt(i,e,t){return(e.y-i.y)*(t.x-e.x)-(e.x-i.x)*(t.y-e.y)}function ta(i,e){return i.x===e.x&&i.y===e.y}function Dv(i,e,t,n){let r=mh(Yt(i,e,t)),s=mh(Yt(i,e,n)),o=mh(Yt(t,n,i)),a=mh(Yt(t,n,e));return!!(r!==s&&o!==a||r===0&&ph(i,t,e)||s===0&&ph(i,n,e)||o===0&&ph(t,i,n)||a===0&&ph(t,e,n))}function ph(i,e,t){return e.x<=Math.max(i.x,t.x)&&e.x>=Math.min(i.x,t.x)&&e.y<=Math.max(i.y,t.y)&&e.y>=Math.min(i.y,t.y)}function mh(i){return i>0?1:i<0?-1:0}function Y_(i,e){let t=i;do{if(t.i!==i.i&&t.next.i!==i.i&&t.i!==e.i&&t.next.i!==e.i&&Dv(t,t.next,i,e))return!0;t=t.next}while(t!==i);return!1}function Gl(i,e){return Yt(i.prev,i,i.next)<0?Yt(i,e,i.next)>=0&&Yt(i,i.prev,e)>=0:Yt(i,e,i.prev)<0||Yt(i,i.next,e)<0}function Z_(i,e){let t=i,n=!1,r=(i.x+e.x)/2,s=(i.y+e.y)/2;do t.y>s!=t.next.y>s&&t.next.y!==t.y&&r<(t.next.x-t.x)*(s-t.y)/(t.next.y-t.y)+t.x&&(n=!n),t=t.next;while(t!==i);return n}function Nv(i,e){let t=xp(i.i,i.x,i.y),n=xp(e.i,e.x,e.y),r=i.next,s=e.prev;return i.next=e,e.prev=i,t.next=r,r.prev=t,n.next=t,t.prev=n,s.next=n,n.prev=s,n}function og(i,e,t,n){let r=xp(i,e,t);return n?(r.next=n.next,r.prev=n,n.next.prev=r,n.next=r):(r.prev=r,r.next=r),r}function Vl(i){i.next.prev=i.prev,i.prev.next=i.next,i.prevZ&&(i.prevZ.nextZ=i.nextZ),i.nextZ&&(i.nextZ.prevZ=i.prevZ)}function xp(i,e,t){return{i,x:e,y:t,prev:null,next:null,z:0,prevZ:null,nextZ:null,steiner:!1}}function $_(i,e,t,n){let r=0;for(let s=e,o=t-n;s<t;s+=n)r+=(i[o]-i[s])*(i[s+1]+i[o+1]),o=s;return r}var yp=class{static triangulate(e,t,n=2){return D_(e,t,n)}},bi=class i{static area(e){let t=e.length,n=0;for(let r=t-1,s=0;s<t;r=s++)n+=e[r].x*e[s].y-e[s].x*e[r].y;return n*.5}static isClockWise(e){return i.area(e)<0}static triangulateShape(e,t){let n=[],r=[],s=[];ag(e),lg(n,e);let o=e.length;t.forEach(ag);for(let l=0;l<t.length;l++)r.push(o),o+=t[l].length,lg(n,t[l]);let a=yp.triangulate(n,r);for(let l=0;l<a.length;l+=3)s.push(a.slice(l,l+3));return s}};function ag(i){let e=i.length;e>2&&i[e-1].equals(i[0])&&i.pop()}function lg(i,e){for(let t=0;t<e.length;t++)i.push(e[t].x),i.push(e[t].y)}var Hl=class i extends et{constructor(e=new Ti([new he(.5,.5),new he(-.5,.5),new he(-.5,-.5),new he(.5,-.5)]),t={}){super(),this.type="ExtrudeGeometry",this.parameters={shapes:e,options:t},e=Array.isArray(e)?e:[e];let n=this,r=[],s=[];for(let a=0,l=e.length;a<l;a++){let c=e[a];o(c)}this.setAttribute("position",new Ve(r,3)),this.setAttribute("uv",new Ve(s,2)),this.computeVertexNormals();function o(a){let l=[],c=t.curveSegments!==void 0?t.curveSegments:12,u=t.steps!==void 0?t.steps:1,f=t.depth!==void 0?t.depth:1,h=t.bevelEnabled!==void 0?t.bevelEnabled:!0,d=t.bevelThickness!==void 0?t.bevelThickness:.2,p=t.bevelSize!==void 0?t.bevelSize:d-.1,v=t.bevelOffset!==void 0?t.bevelOffset:0,g=t.bevelSegments!==void 0?t.bevelSegments:3,m=t.extrudePath,y=t.UVGenerator!==void 0?t.UVGenerator:J_,_,x=!1,S,b,E,M;if(m){_=m.getSpacedPoints(u),x=!0,h=!1;let ae=m.isCatmullRomCurve3?m.closed:!1;S=m.computeFrenetFrames(u,ae),b=new R,E=new R,M=new R}h||(g=0,d=0,p=0,v=0);let T=a.extractPoints(c),A=T.shape,I=T.holes;if(!bi.isClockWise(A)){A=A.reverse();for(let ae=0,xe=I.length;ae<xe;ae++){let we=I[ae];bi.isClockWise(we)&&(I[ae]=we.reverse())}}function B(ae){let we=10000000000000001e-36,Ae=ae[0];for(let Te=1;Te<=ae.length;Te++){let de=Te%ae.length,Oe=ae[de],Re=Oe.x-Ae.x,Je=Oe.y-Ae.y,z=Re*Re+Je*Je,lt=Math.max(Math.abs(Oe.x),Math.abs(Oe.y),Math.abs(Ae.x),Math.abs(Ae.y)),rt=we*lt*lt;if(z<=rt){ae.splice(de,1),Te--;continue}Ae=Oe}}B(A),I.forEach(B);let F=I.length,L=A;for(let ae=0;ae<F;ae++){let xe=I[ae];A=A.concat(xe)}function U(ae,xe,we){return xe||Qe("ExtrudeGeometry: vec does not exist"),ae.clone().addScaledVector(xe,we)}let X=A.length;function te(ae,xe,we){let Ae,Te,de,Oe=ae.x-xe.x,Re=ae.y-xe.y,Je=we.x-ae.x,z=we.y-ae.y,lt=Oe*Oe+Re*Re,rt=Oe*z-Re*Je;if(Math.abs(rt)>Number.EPSILON){let P=Math.sqrt(lt),w=Math.sqrt(Je*Je+z*z),q=xe.x-Re/P,J=xe.y+Oe/P,G=we.x-z/w,re=we.y+Je/w,Q=((G-q)*z-(re-J)*Je)/(Oe*z-Re*Je);Ae=q+Oe*Q-ae.x,Te=J+Re*Q-ae.y;let V=Ae*Ae+Te*Te;if(V<=2)return new he(Ae,Te);de=Math.sqrt(V/2)}else{let P=!1;Oe>Number.EPSILON?Je>Number.EPSILON&&(P=!0):Oe<-Number.EPSILON?Je<-Number.EPSILON&&(P=!0):Math.sign(Re)===Math.sign(z)&&(P=!0),P?(Ae=-Re,Te=Oe,de=Math.sqrt(lt)):(Ae=Oe,Te=Re,de=Math.sqrt(lt/2))}return new he(Ae/de,Te/de)}let Z=[];for(let ae=0,xe=L.length,we=xe-1,Ae=ae+1;ae<xe;ae++,we++,Ae++)we===xe&&(we=0),Ae===xe&&(Ae=0),Z[ae]=te(L[ae],L[we],L[Ae]);let K=[],j,ne=Z.concat();for(let ae=0,xe=F;ae<xe;ae++){let we=I[ae];j=[];for(let Ae=0,Te=we.length,de=Te-1,Oe=Ae+1;Ae<Te;Ae++,de++,Oe++)de===Te&&(de=0),Oe===Te&&(Oe=0),j[Ae]=te(we[Ae],we[de],we[Oe]);K.push(j),ne=ne.concat(j)}let ie;if(g===0)ie=bi.triangulateShape(L,I);else{let ae=[],xe=[];for(let we=0;we<g;we++){let Ae=we/g,Te=d*Math.cos(Ae*Math.PI/2),de=p*Math.sin(Ae*Math.PI/2)+v;for(let Oe=0,Re=L.length;Oe<Re;Oe++){let Je=U(L[Oe],Z[Oe],de);Ce(Je.x,Je.y,-Te),Ae===0&&ae.push(Je)}for(let Oe=0,Re=F;Oe<Re;Oe++){let Je=I[Oe];j=K[Oe];let z=[];for(let lt=0,rt=Je.length;lt<rt;lt++){let P=U(Je[lt],j[lt],de);Ce(P.x,P.y,-Te),Ae===0&&z.push(P)}Ae===0&&xe.push(z)}}ie=bi.triangulateShape(ae,xe)}let We=ie.length,Fe=p+v;for(let ae=0;ae<X;ae++){let xe=h?U(A[ae],ne[ae],Fe):A[ae];x?(E.copy(S.normals[0]).multiplyScalar(xe.x),b.copy(S.binormals[0]).multiplyScalar(xe.y),M.copy(_[0]).add(E).add(b),Ce(M.x,M.y,M.z)):Ce(xe.x,xe.y,0)}for(let ae=1;ae<=u;ae++)for(let xe=0;xe<X;xe++){let we=h?U(A[xe],ne[xe],Fe):A[xe];x?(E.copy(S.normals[ae]).multiplyScalar(we.x),b.copy(S.binormals[ae]).multiplyScalar(we.y),M.copy(_[ae]).add(E).add(b),Ce(M.x,M.y,M.z)):Ce(we.x,we.y,f/u*ae)}for(let ae=g-1;ae>=0;ae--){let xe=ae/g,we=d*Math.cos(xe*Math.PI/2),Ae=p*Math.sin(xe*Math.PI/2)+v;for(let Te=0,de=L.length;Te<de;Te++){let Oe=U(L[Te],Z[Te],Ae);Ce(Oe.x,Oe.y,f+we)}for(let Te=0,de=I.length;Te<de;Te++){let Oe=I[Te];j=K[Te];for(let Re=0,Je=Oe.length;Re<Je;Re++){let z=U(Oe[Re],j[Re],Ae);x?Ce(z.x,z.y+_[u-1].y,_[u-1].x+we):Ce(z.x,z.y,f+we)}}}Ye(),$();function Ye(){let ae=r.length/3;if(h){let xe=0,we=X*xe;for(let Ae=0;Ae<We;Ae++){let Te=ie[Ae];He(Te[2]+we,Te[1]+we,Te[0]+we)}xe=u+g*2,we=X*xe;for(let Ae=0;Ae<We;Ae++){let Te=ie[Ae];He(Te[0]+we,Te[1]+we,Te[2]+we)}}else{for(let xe=0;xe<We;xe++){let we=ie[xe];He(we[2],we[1],we[0])}for(let xe=0;xe<We;xe++){let we=ie[xe];He(we[0]+X*u,we[1]+X*u,we[2]+X*u)}}n.addGroup(ae,r.length/3-ae,0)}function $(){let ae=r.length/3,xe=0;oe(L,xe),xe+=L.length;for(let we=0,Ae=I.length;we<Ae;we++){let Te=I[we];oe(Te,xe),xe+=Te.length}n.addGroup(ae,r.length/3-ae,1)}function oe(ae,xe){let we=ae.length;for(;--we>=0;){let Ae=we,Te=we-1;Te<0&&(Te=ae.length-1);for(let de=0,Oe=u+g*2;de<Oe;de++){let Re=X*de,Je=X*(de+1),z=xe+Ae+Re,lt=xe+Te+Re,rt=xe+Te+Je,P=xe+Ae+Je;Ee(z,lt,rt,P)}}}function Ce(ae,xe,we){l.push(ae),l.push(xe),l.push(we)}function He(ae,xe,we){ze(ae),ze(xe),ze(we);let Ae=r.length/3,Te=y.generateTopUV(n,r,Ae-3,Ae-2,Ae-1);pt(Te[0]),pt(Te[1]),pt(Te[2])}function Ee(ae,xe,we,Ae){ze(ae),ze(xe),ze(Ae),ze(xe),ze(we),ze(Ae);let Te=r.length/3,de=y.generateSideWallUV(n,r,Te-6,Te-3,Te-2,Te-1);pt(de[0]),pt(de[1]),pt(de[3]),pt(de[1]),pt(de[2]),pt(de[3])}function ze(ae){r.push(l[ae*3+0]),r.push(l[ae*3+1]),r.push(l[ae*3+2])}function pt(ae){s.push(ae.x),s.push(ae.y)}}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}toJSON(){let e=super.toJSON(),t=this.parameters.shapes,n=this.parameters.options;return K_(t,n,e)}static fromJSON(e,t){let n=[];for(let s=0,o=e.shapes.length;s<o;s++){let a=t[e.shapes[s]];n.push(a)}let r=e.options.extrudePath;return r!==void 0&&(e.options.extrudePath=new Wh[r.type]().fromJSON(r)),new i(n,e.options)}},J_={generateTopUV:function(i,e,t,n,r){let s=e[t*3],o=e[t*3+1],a=e[n*3],l=e[n*3+1],c=e[r*3],u=e[r*3+1];return[new he(s,o),new he(a,l),new he(c,u)]},generateSideWallUV:function(i,e,t,n,r,s){let o=e[t*3],a=e[t*3+1],l=e[t*3+2],c=e[n*3],u=e[n*3+1],f=e[n*3+2],h=e[r*3],d=e[r*3+1],p=e[r*3+2],v=e[s*3],g=e[s*3+1],m=e[s*3+2];return Math.abs(a-u)<Math.abs(o-c)?[new he(o,1-l),new he(c,1-f),new he(h,1-p),new he(v,1-m)]:[new he(a,1-l),new he(u,1-f),new he(d,1-p),new he(g,1-m)]}};function K_(i,e,t){if(t.shapes=[],Array.isArray(i))for(let n=0,r=i.length;n<r;n++){let s=i[n];t.shapes.push(s.uuid)}else t.shapes.push(i.uuid);return t.options=Object.assign({},e),e.extrudePath!==void 0&&(t.options.extrudePath=e.extrudePath.toJSON()),t}var Os=class i extends br{constructor(e=1,t=0){let n=(1+Math.sqrt(5))/2,r=[-1,n,0,1,n,0,-1,-n,0,1,-n,0,0,-1,n,0,1,n,0,-1,-n,0,1,-n,n,0,-1,n,0,1,-n,0,-1,-n,0,1],s=[0,11,5,0,5,1,0,1,7,0,7,10,0,10,11,1,5,9,5,11,4,11,10,2,10,7,6,7,1,8,3,9,4,3,4,2,3,2,6,3,6,8,3,8,9,4,9,5,2,4,11,6,2,10,8,6,7,9,8,1];super(r,s,e,t),this.type="IcosahedronGeometry",this.parameters={radius:e,detail:t}}static fromJSON(e){return new i(e.radius,e.detail)}},Wl=class i extends et{constructor(e=[new he(0,-.5),new he(.5,0),new he(0,.5)],t=12,n=0,r=Math.PI*2){super(),this.type="LatheGeometry",this.parameters={points:e,segments:t,phiStart:n,phiLength:r},t=Math.floor(t),r=ot(r,0,Math.PI*2);let s=[],o=[],a=[],l=[],c=[],u=1/t,f=new R,h=new he,d=new R,p=new R,v=new R,g=0,m=0;for(let y=0;y<=e.length-1;y++)switch(y){case 0:g=e[y+1].x-e[y].x,m=e[y+1].y-e[y].y,d.x=m*1,d.y=-g,d.z=m*0,v.copy(d),d.normalize(),l.push(d.x,d.y,d.z);break;case e.length-1:l.push(v.x,v.y,v.z);break;default:g=e[y+1].x-e[y].x,m=e[y+1].y-e[y].y,d.x=m*1,d.y=-g,d.z=m*0,p.copy(d),d.x+=v.x,d.y+=v.y,d.z+=v.z,d.normalize(),l.push(d.x,d.y,d.z),v.copy(p)}for(let y=0;y<=t;y++){let _=n+y*u*r,x=Math.sin(_),S=Math.cos(_);for(let b=0;b<=e.length-1;b++){f.x=e[b].x*x,f.y=e[b].y,f.z=e[b].x*S,o.push(f.x,f.y,f.z),h.x=y/t,h.y=b/(e.length-1),a.push(h.x,h.y);let E=l[3*b+0]*x,M=l[3*b+1],T=l[3*b+0]*S;c.push(E,M,T)}}for(let y=0;y<t;y++)for(let _=0;_<e.length-1;_++){let x=_+y*e.length,S=x,b=x+e.length,E=x+e.length+1,M=x+1;s.push(S,b,M),s.push(E,M,b)}this.setIndex(s),this.setAttribute("position",new Ve(o,3)),this.setAttribute("uv",new Ve(a,2)),this.setAttribute("normal",new Ve(c,3))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new i(e.points,e.segments,e.phiStart,e.phiLength)}},na=class i extends br{constructor(e=1,t=0){let n=[1,0,0,-1,0,0,0,1,0,0,-1,0,0,0,1,0,0,-1],r=[0,2,4,0,4,3,0,3,5,0,5,2,1,2,5,1,5,3,1,3,4,1,4,2];super(n,r,e,t),this.type="OctahedronGeometry",this.parameters={radius:e,detail:t}}static fromJSON(e){return new i(e.radius,e.detail)}},ji=class i extends et{constructor(e=1,t=1,n=1,r=1){super(),this.type="PlaneGeometry",this.parameters={width:e,height:t,widthSegments:n,heightSegments:r};let s=e/2,o=t/2,a=Math.floor(n),l=Math.floor(r),c=a+1,u=l+1,f=e/a,h=t/l,d=[],p=[],v=[],g=[];for(let m=0;m<u;m++){let y=m*h-o;for(let _=0;_<c;_++){let x=_*f-s;p.push(x,-y,0),v.push(0,0,1),g.push(_/a),g.push(1-m/l)}}for(let m=0;m<l;m++)for(let y=0;y<a;y++){let _=y+c*m,x=y+c*(m+1),S=y+1+c*(m+1),b=y+1+c*m;d.push(_,x,b),d.push(x,S,b)}this.setIndex(d),this.setAttribute("position",new Ve(p,3)),this.setAttribute("normal",new Ve(v,3)),this.setAttribute("uv",new Ve(g,2))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new i(e.width,e.height,e.widthSegments,e.heightSegments)}},Xl=class i extends et{constructor(e=.5,t=1,n=32,r=1,s=0,o=Math.PI*2){super(),this.type="RingGeometry",this.parameters={innerRadius:e,outerRadius:t,thetaSegments:n,phiSegments:r,thetaStart:s,thetaLength:o},n=Math.max(3,n),r=Math.max(1,r);let a=[],l=[],c=[],u=[],f=e,h=(t-e)/r,d=new R,p=new he;for(let v=0;v<=r;v++){for(let g=0;g<=n;g++){let m=s+g/n*o;d.x=f*Math.cos(m),d.y=f*Math.sin(m),l.push(d.x,d.y,d.z),c.push(0,0,1),p.x=(d.x/t+1)/2,p.y=(d.y/t+1)/2,u.push(p.x,p.y)}f+=h}for(let v=0;v<r;v++){let g=v*(n+1);for(let m=0;m<n;m++){let y=m+g,_=y,x=y+n+1,S=y+n+2,b=y+1;a.push(_,x,b),a.push(x,S,b)}}this.setIndex(a),this.setAttribute("position",new Ve(l,3)),this.setAttribute("normal",new Ve(c,3)),this.setAttribute("uv",new Ve(u,2))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new i(e.innerRadius,e.outerRadius,e.thetaSegments,e.phiSegments,e.thetaStart,e.thetaLength)}},wr=class i extends et{constructor(e=new Ti([new he(0,.5),new he(-.5,-.5),new he(.5,-.5)]),t=12){super(),this.type="ShapeGeometry",this.parameters={shapes:e,curveSegments:t};let n=[],r=[],s=[],o=[],a=0,l=0;if(Array.isArray(e)===!1)c(e);else for(let u=0;u<e.length;u++)c(e[u]),this.addGroup(a,l,u),a+=l,l=0;this.setIndex(n),this.setAttribute("position",new Ve(r,3)),this.setAttribute("normal",new Ve(s,3)),this.setAttribute("uv",new Ve(o,2));function c(u){let f=r.length/3,h=u.extractPoints(t),d=h.shape,p=h.holes;bi.isClockWise(d)===!1&&(d=d.reverse());for(let g=0,m=p.length;g<m;g++){let y=p[g];bi.isClockWise(y)===!0&&(p[g]=y.reverse())}let v=bi.triangulateShape(d,p);for(let g=0,m=p.length;g<m;g++){let y=p[g];d=d.concat(y)}for(let g=0,m=d.length;g<m;g++){let y=d[g];r.push(y.x,y.y,0),s.push(0,0,1),o.push(y.x,y.y)}for(let g=0,m=v.length;g<m;g++){let y=v[g],_=y[0]+f,x=y[1]+f,S=y[2]+f;n.push(_,x,S),l+=3}}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}toJSON(){let e=super.toJSON(),t=this.parameters.shapes;return j_(t,e)}static fromJSON(e,t){let n=[];for(let r=0,s=e.shapes.length;r<s;r++){let o=t[e.shapes[r]];n.push(o)}return new i(n,e.curveSegments)}};function j_(i,e){if(e.shapes=[],Array.isArray(i))for(let t=0,n=i.length;t<n;t++){let r=i[t];e.shapes.push(r.uuid)}else e.shapes.push(i.uuid);return e}var mn=class i extends et{constructor(e=1,t=32,n=16,r=0,s=Math.PI*2,o=0,a=Math.PI){super(),this.type="SphereGeometry",this.parameters={radius:e,widthSegments:t,heightSegments:n,phiStart:r,phiLength:s,thetaStart:o,thetaLength:a},t=Math.max(3,Math.floor(t)),n=Math.max(2,Math.floor(n));let l=Math.min(o+a,Math.PI),c=0,u=[],f=new R,h=new R,d=[],p=[],v=[],g=[];for(let m=0;m<=n;m++){let y=[],_=m/n,x=o+_*a,S=e*Math.cos(x),b=Math.sqrt(e*e-S*S),E=0;m===0&&o===0?E=.5/t:m===n&&l===Math.PI&&(E=-.5/t);for(let M=0;M<=t;M++){let T=M/t,A=r+T*s;f.x=-b*Math.cos(A),f.y=S,f.z=b*Math.sin(A),p.push(f.x,f.y,f.z),h.copy(f).normalize(),v.push(h.x,h.y,h.z),g.push(T+E,1-_),y.push(c++)}u.push(y)}for(let m=0;m<n;m++)for(let y=0;y<t;y++){let _=u[m][y+1],x=u[m][y],S=u[m+1][y],b=u[m+1][y+1];(m!==0||o>0)&&d.push(_,x,b),(m!==n-1||l<Math.PI)&&d.push(x,S,b)}this.setIndex(d),this.setAttribute("position",new Ve(p,3)),this.setAttribute("normal",new Ve(v,3)),this.setAttribute("uv",new Ve(g,2))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new i(e.radius,e.widthSegments,e.heightSegments,e.phiStart,e.phiLength,e.thetaStart,e.thetaLength)}},ql=class i extends br{constructor(e=1,t=0){let n=[1,1,1,-1,-1,1,-1,1,-1,1,-1,-1],r=[2,1,0,0,3,2,1,3,0,2,3,1];super(n,r,e,t),this.type="TetrahedronGeometry",this.parameters={radius:e,detail:t}}static fromJSON(e){return new i(e.radius,e.detail)}},Yl=class i extends et{constructor(e=1,t=.4,n=12,r=48,s=Math.PI*2,o=0,a=Math.PI*2){super(),this.type="TorusGeometry",this.parameters={radius:e,tube:t,radialSegments:n,tubularSegments:r,arc:s,thetaStart:o,thetaLength:a},n=Math.floor(n),r=Math.floor(r);let l=[],c=[],u=[],f=[],h=new R,d=new R,p=new R;for(let v=0;v<=n;v++){let g=o+v/n*a;for(let m=0;m<=r;m++){let y=m/r*s;d.x=(e+t*Math.cos(g))*Math.cos(y),d.y=(e+t*Math.cos(g))*Math.sin(y),d.z=t*Math.sin(g),c.push(d.x,d.y,d.z),h.x=e*Math.cos(y),h.y=e*Math.sin(y),p.subVectors(d,h).normalize(),u.push(p.x,p.y,p.z),f.push(m/r),f.push(v/n)}}for(let v=1;v<=n;v++)for(let g=1;g<=r;g++){let m=(r+1)*v+g-1,y=(r+1)*(v-1)+g-1,_=(r+1)*(v-1)+g,x=(r+1)*v+g;l.push(m,y,x),l.push(y,_,x)}this.setIndex(l),this.setAttribute("position",new Ve(c,3)),this.setAttribute("normal",new Ve(u,3)),this.setAttribute("uv",new Ve(f,2))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new i(e.radius,e.tube,e.radialSegments,e.tubularSegments,e.arc,e.thetaStart,e.thetaLength)}},Zl=class i extends et{constructor(e=1,t=.4,n=64,r=8,s=2,o=3){super(),this.type="TorusKnotGeometry",this.parameters={radius:e,tube:t,tubularSegments:n,radialSegments:r,p:s,q:o},n=Math.floor(n),r=Math.floor(r);let a=[],l=[],c=[],u=[],f=new R,h=new R,d=new R,p=new R,v=new R,g=new R,m=new R;for(let _=0;_<=n;++_){let x=_/n*s*Math.PI*2;y(x,s,o,e,d),y(x+.01,s,o,e,p),g.subVectors(p,d),m.addVectors(p,d),v.crossVectors(g,m),m.crossVectors(v,g),v.normalize(),m.normalize();for(let S=0;S<=r;++S){let b=S/r*Math.PI*2,E=-t*Math.cos(b),M=t*Math.sin(b);f.x=d.x+(E*m.x+M*v.x),f.y=d.y+(E*m.y+M*v.y),f.z=d.z+(E*m.z+M*v.z),l.push(f.x,f.y,f.z),h.subVectors(f,d).normalize(),c.push(h.x,h.y,h.z),u.push(_/n),u.push(S/r)}}for(let _=1;_<=n;_++)for(let x=1;x<=r;x++){let S=(r+1)*(_-1)+(x-1),b=(r+1)*_+(x-1),E=(r+1)*_+x,M=(r+1)*(_-1)+x;a.push(S,b,M),a.push(b,E,M)}this.setIndex(a),this.setAttribute("position",new Ve(l,3)),this.setAttribute("normal",new Ve(c,3)),this.setAttribute("uv",new Ve(u,2));function y(_,x,S,b,E){let M=Math.cos(_),T=Math.sin(_),A=S/x*_,I=Math.cos(A);E.x=b*(2+I)*.5*M,E.y=b*(2+I)*T*.5,E.z=b*Math.sin(A)*.5}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new i(e.radius,e.tube,e.tubularSegments,e.radialSegments,e.p,e.q)}},$l=class i extends et{constructor(e=new Qo(new R(-1,-1,0),new R(-1,1,0),new R(1,1,0)),t=64,n=1,r=8,s=!1){super(),this.type="TubeGeometry",this.parameters={path:e,tubularSegments:t,radius:n,radialSegments:r,closed:s};let o=e.computeFrenetFrames(t,s);this.tangents=o.tangents,this.normals=o.normals,this.binormals=o.binormals;let a=new R,l=new R,c=new he,u=new R,f=[],h=[],d=[],p=[];v(),this.setIndex(p),this.setAttribute("position",new Ve(f,3)),this.setAttribute("normal",new Ve(h,3)),this.setAttribute("uv",new Ve(d,2));function v(){for(let _=0;_<t;_++)g(_);g(s===!1?t:0),y(),m()}function g(_){u=e.getPointAt(_/t,u);let x=o.normals[_],S=o.binormals[_];for(let b=0;b<=r;b++){let E=b/r*Math.PI*2,M=Math.sin(E),T=-Math.cos(E);l.x=T*x.x+M*S.x,l.y=T*x.y+M*S.y,l.z=T*x.z+M*S.z,l.normalize(),h.push(l.x,l.y,l.z),a.x=u.x+n*l.x,a.y=u.y+n*l.y,a.z=u.z+n*l.z,f.push(a.x,a.y,a.z)}}function m(){for(let _=1;_<=t;_++)for(let x=1;x<=r;x++){let S=(r+1)*(_-1)+(x-1),b=(r+1)*_+(x-1),E=(r+1)*_+x,M=(r+1)*(_-1)+x;p.push(S,b,M),p.push(b,E,M)}}function y(){for(let _=0;_<=t;_++)for(let x=0;x<=r;x++)c.x=_/t,c.y=x/r,d.push(c.x,c.y)}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}toJSON(){let e=super.toJSON();return e.path=this.parameters.path.toJSON(),e}static fromJSON(e){return new i(new Wh[e.path.type]().fromJSON(e.path),e.tubularSegments,e.radius,e.radialSegments,e.closed)}},Jl=class extends et{constructor(e=null){if(super(),this.type="WireframeGeometry",this.parameters={geometry:e},e!==null){let t=[],n=new Set,r=new R,s=new R;if(e.index!==null){let o=e.attributes.position,a=e.index,l=e.groups;l.length===0&&(l=[{start:0,count:a.count,materialIndex:0}]);for(let c=0,u=l.length;c<u;++c){let f=l[c],h=f.start,d=f.count;for(let p=h,v=h+d;p<v;p+=3)for(let g=0;g<3;g++){let m=a.getX(p+g),y=a.getX(p+(g+1)%3);r.fromBufferAttribute(o,m),s.fromBufferAttribute(o,y),cg(r,s,n)===!0&&(t.push(r.x,r.y,r.z),t.push(s.x,s.y,s.z))}}}else{let o=e.attributes.position;for(let a=0,l=o.count/3;a<l;a++)for(let c=0;c<3;c++){let u=3*a+c,f=3*a+(c+1)%3;r.fromBufferAttribute(o,u),s.fromBufferAttribute(o,f),cg(r,s,n)===!0&&(t.push(r.x,r.y,r.z),t.push(s.x,s.y,s.z))}}this.setAttribute("position",new Ve(t,3))}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}};function cg(i,e,t){let n=`${i.x},${i.y},${i.z}-${e.x},${e.y},${e.z}`,r=`${e.x},${e.y},${e.z}-${i.x},${i.y},${i.z}`;return t.has(n)===!0||t.has(r)===!0?!1:(t.add(n),t.add(r),!0)}var ug=Object.freeze({__proto__:null,BoxGeometry:In,CapsuleGeometry:Nl,CircleGeometry:Ds,ConeGeometry:Qn,CylinderGeometry:pn,DodecahedronGeometry:Ns,EdgesGeometry:Fl,ExtrudeGeometry:Hl,IcosahedronGeometry:Os,LatheGeometry:Wl,OctahedronGeometry:na,PlaneGeometry:ji,PolyhedronGeometry:br,RingGeometry:Xl,ShapeGeometry:wr,SphereGeometry:mn,TetrahedronGeometry:ql,TorusGeometry:Yl,TorusKnotGeometry:Zl,TubeGeometry:$l,WireframeGeometry:Jl}),Kl=class extends an{constructor(e){super(),this.isShadowMaterial=!0,this.type="ShadowMaterial",this.color=new be(0),this.transparent=!0,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.fog=e.fog,this}};function Qs(i){let e={};for(let t in i){e[t]={};for(let n in i[t]){let r=i[t][n];if(hg(r))r.isRenderTargetTexture?(Ge("UniformsUtils: Textures of render targets cannot be cloned via cloneUniforms() or mergeUniforms()."),e[t][n]=null):e[t][n]=r.clone();else if(Array.isArray(r))if(hg(r[0])){let s=[];for(let o=0,a=r.length;o<a;o++)s[o]=r[o].clone();e[t][n]=s}else e[t][n]=r.slice();else e[t][n]=r}}return e}function Ln(i){let e={};for(let t=0;t<i.length;t++){let n=Qs(i[t]);for(let r in n)e[r]=n[r]}return e}function hg(i){return i&&(i.isColor||i.isMatrix3||i.isMatrix4||i.isVector2||i.isVector3||i.isVector4||i.isTexture||i.isQuaternion)}function Q_(i){let e=[];for(let t=0;t<i.length;t++)e.push(i[t].clone());return e}function gm(i){let e=i.getRenderTarget();return e===null?i.outputColorSpace:e.isXRRenderTarget===!0?e.texture.colorSpace:vt.workingColorSpace}var rr={clone:Qs,merge:Ln},e1=`void main() {
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`,t1=`void main() {
	gl_FragColor = vec4( 1.0, 0.0, 0.0, 1.0 );
}`,Lt=class extends an{constructor(e){super(),this.isShaderMaterial=!0,this.type="ShaderMaterial",this.defines={},this.uniforms={},this.uniformsGroups=[],this.vertexShader=e1,this.fragmentShader=t1,this.linewidth=1,this.wireframe=!1,this.wireframeLinewidth=1,this.fog=!1,this.lights=!1,this.clipping=!1,this.forceSinglePass=!0,this.extensions={clipCullDistance:!1,multiDraw:!1},this.defaultAttributeValues={color:[1,1,1],uv:[0,0],uv1:[0,0]},this.index0AttributeName=void 0,this.uniformsNeedUpdate=!1,this.glslVersion=null,e!==void 0&&this.setValues(e)}copy(e){return super.copy(e),this.fragmentShader=e.fragmentShader,this.vertexShader=e.vertexShader,this.uniforms=Qs(e.uniforms),this.uniformsGroups=Q_(e.uniformsGroups),this.defines=Object.assign({},e.defines),this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.fog=e.fog,this.lights=e.lights,this.clipping=e.clipping,this.extensions=Object.assign({},e.extensions),this.glslVersion=e.glslVersion,this.defaultAttributeValues=Object.assign({},e.defaultAttributeValues),this.index0AttributeName=e.index0AttributeName,this.uniformsNeedUpdate=e.uniformsNeedUpdate,this}toJSON(e){let t=super.toJSON(e);t.glslVersion=this.glslVersion,t.uniforms={};for(let r in this.uniforms){let o=this.uniforms[r].value;o&&o.isTexture?t.uniforms[r]={type:"t",value:o.toJSON(e).uuid}:o&&o.isColor?t.uniforms[r]={type:"c",value:o.getHex()}:o&&o.isVector2?t.uniforms[r]={type:"v2",value:o.toArray()}:o&&o.isVector3?t.uniforms[r]={type:"v3",value:o.toArray()}:o&&o.isVector4?t.uniforms[r]={type:"v4",value:o.toArray()}:o&&o.isMatrix3?t.uniforms[r]={type:"m3",value:o.toArray()}:o&&o.isMatrix4?t.uniforms[r]={type:"m4",value:o.toArray()}:t.uniforms[r]={value:o}}Object.keys(this.defines).length>0&&(t.defines=this.defines),t.vertexShader=this.vertexShader,t.fragmentShader=this.fragmentShader,t.lights=this.lights,t.clipping=this.clipping;let n={};for(let r in this.extensions)this.extensions[r]===!0&&(n[r]=!0);return Object.keys(n).length>0&&(t.extensions=n),t}fromJSON(e,t){if(super.fromJSON(e,t),e.uniforms!==void 0)for(let n in e.uniforms){let r=e.uniforms[n];switch(this.uniforms[n]={},r.type){case"t":this.uniforms[n].value=t[r.value]||null;break;case"c":this.uniforms[n].value=new be().setHex(r.value);break;case"v2":this.uniforms[n].value=new he().fromArray(r.value);break;case"v3":this.uniforms[n].value=new R().fromArray(r.value);break;case"v4":this.uniforms[n].value=new Pt().fromArray(r.value);break;case"m3":this.uniforms[n].value=new ft().fromArray(r.value);break;case"m4":this.uniforms[n].value=new it().fromArray(r.value);break;default:this.uniforms[n].value=r.value}}if(e.defines!==void 0&&(this.defines=e.defines),e.vertexShader!==void 0&&(this.vertexShader=e.vertexShader),e.fragmentShader!==void 0&&(this.fragmentShader=e.fragmentShader),e.glslVersion!==void 0&&(this.glslVersion=e.glslVersion),e.extensions!==void 0)for(let n in e.extensions)this.extensions[n]=e.extensions[n];return e.lights!==void 0&&(this.lights=e.lights),e.clipping!==void 0&&(this.clipping=e.clipping),this}},Qr=class extends Lt{constructor(e){super(e),this.isRawShaderMaterial=!0,this.type="RawShaderMaterial"}},Dt=class extends an{constructor(e){super(),this.isMeshStandardMaterial=!0,this.type="MeshStandardMaterial",this.defines={STANDARD:""},this.color=new be(16777215),this.roughness=1,this.metalness=0,this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.emissive=new be(0),this.emissiveIntensity=1,this.emissiveMap=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=nr,this.normalScale=new he(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.roughnessMap=null,this.metalnessMap=null,this.alphaMap=null,this.envMap=null,this.envMapRotation=new Vn,this.envMapIntensity=1,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.flatShading=!1,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.defines={STANDARD:""},this.color.copy(e.color),this.roughness=e.roughness,this.metalness=e.metalness,this.map=e.map,this.lightMap=e.lightMap,this.lightMapIntensity=e.lightMapIntensity,this.aoMap=e.aoMap,this.aoMapIntensity=e.aoMapIntensity,this.emissive.copy(e.emissive),this.emissiveMap=e.emissiveMap,this.emissiveIntensity=e.emissiveIntensity,this.bumpMap=e.bumpMap,this.bumpScale=e.bumpScale,this.normalMap=e.normalMap,this.normalMapType=e.normalMapType,this.normalScale.copy(e.normalScale),this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.roughnessMap=e.roughnessMap,this.metalnessMap=e.metalnessMap,this.alphaMap=e.alphaMap,this.envMap=e.envMap,this.envMapRotation.copy(e.envMapRotation),this.envMapIntensity=e.envMapIntensity,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.wireframeLinecap=e.wireframeLinecap,this.wireframeLinejoin=e.wireframeLinejoin,this.flatShading=e.flatShading,this.fog=e.fog,this}},jl=class extends Dt{constructor(e){super(),this.isMeshPhysicalMaterial=!0,this.defines={STANDARD:"",PHYSICAL:""},this.type="MeshPhysicalMaterial",this.anisotropyRotation=0,this.anisotropyMap=null,this.clearcoatMap=null,this.clearcoatRoughness=0,this.clearcoatRoughnessMap=null,this.clearcoatNormalScale=new he(1,1),this.clearcoatNormalMap=null,this.ior=1.5,Object.defineProperty(this,"reflectivity",{get:function(){return ot(2.5*(this.ior-1)/(this.ior+1),0,1)},set:function(t){this.ior=(1+.4*t)/(1-.4*t)}}),this.iridescenceMap=null,this.iridescenceIOR=1.3,this.iridescenceThicknessRange=[100,400],this.iridescenceThicknessMap=null,this.sheenColor=new be(0),this.sheenColorMap=null,this.sheenRoughness=1,this.sheenRoughnessMap=null,this.transmissionMap=null,this.thickness=0,this.thicknessMap=null,this.attenuationDistance=1/0,this.attenuationColor=new be(1,1,1),this.specularIntensity=1,this.specularIntensityMap=null,this.specularColor=new be(1,1,1),this.specularColorMap=null,this._anisotropy=0,this._clearcoat=0,this._dispersion=0,this._iridescence=0,this._retroreflectivity=0,this._sheen=0,this._transmission=0,this.setValues(e)}get anisotropy(){return this._anisotropy}set anisotropy(e){this._anisotropy>0!=e>0&&this.version++,this._anisotropy=e}get clearcoat(){return this._clearcoat}set clearcoat(e){this._clearcoat>0!=e>0&&this.version++,this._clearcoat=e}get iridescence(){return this._iridescence}set iridescence(e){this._iridescence>0!=e>0&&this.version++,this._iridescence=e}get dispersion(){return this._dispersion}set dispersion(e){this._dispersion>0!=e>0&&this.version++,this._dispersion=e}get retroreflectivity(){return this._retroreflectivity}set retroreflectivity(e){this._retroreflectivity>0!=e>0&&this.version++,this._retroreflectivity=e}get sheen(){return this._sheen}set sheen(e){this._sheen>0!=e>0&&this.version++,this._sheen=e}get transmission(){return this._transmission}set transmission(e){this._transmission>0!=e>0&&this.version++,this._transmission=e}copy(e){return super.copy(e),this.defines={STANDARD:"",PHYSICAL:""},this.anisotropy=e.anisotropy,this.anisotropyRotation=e.anisotropyRotation,this.anisotropyMap=e.anisotropyMap,this.clearcoat=e.clearcoat,this.clearcoatMap=e.clearcoatMap,this.clearcoatRoughness=e.clearcoatRoughness,this.clearcoatRoughnessMap=e.clearcoatRoughnessMap,this.clearcoatNormalMap=e.clearcoatNormalMap,this.clearcoatNormalScale.copy(e.clearcoatNormalScale),this.dispersion=e.dispersion,this.ior=e.ior,this.iridescence=e.iridescence,this.iridescenceMap=e.iridescenceMap,this.iridescenceIOR=e.iridescenceIOR,this.iridescenceThicknessRange=[...e.iridescenceThicknessRange],this.iridescenceThicknessMap=e.iridescenceThicknessMap,this.retroreflectivity=e.retroreflectivity,this.sheen=e.sheen,this.sheenColor.copy(e.sheenColor),this.sheenColorMap=e.sheenColorMap,this.sheenRoughness=e.sheenRoughness,this.sheenRoughnessMap=e.sheenRoughnessMap,this.transmission=e.transmission,this.transmissionMap=e.transmissionMap,this.thickness=e.thickness,this.thicknessMap=e.thicknessMap,this.attenuationDistance=e.attenuationDistance,this.attenuationColor.copy(e.attenuationColor),this.specularIntensity=e.specularIntensity,this.specularIntensityMap=e.specularIntensityMap,this.specularColor.copy(e.specularColor),this.specularColorMap=e.specularColorMap,this}},Ql=class extends an{constructor(e){super(),this.isMeshPhongMaterial=!0,this.type="MeshPhongMaterial",this.color=new be(16777215),this.specular=new be(1118481),this.shininess=30,this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.emissive=new be(0),this.emissiveIntensity=1,this.emissiveMap=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=nr,this.normalScale=new he(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.specularMap=null,this.alphaMap=null,this.envMap=null,this.envMapRotation=new Vn,this.combine=fa,this.reflectivity=1,this.envMapIntensity=1,this.refractionRatio=.98,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.flatShading=!1,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.specular.copy(e.specular),this.shininess=e.shininess,this.map=e.map,this.lightMap=e.lightMap,this.lightMapIntensity=e.lightMapIntensity,this.aoMap=e.aoMap,this.aoMapIntensity=e.aoMapIntensity,this.emissive.copy(e.emissive),this.emissiveMap=e.emissiveMap,this.emissiveIntensity=e.emissiveIntensity,this.bumpMap=e.bumpMap,this.bumpScale=e.bumpScale,this.normalMap=e.normalMap,this.normalMapType=e.normalMapType,this.normalScale.copy(e.normalScale),this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.specularMap=e.specularMap,this.alphaMap=e.alphaMap,this.envMap=e.envMap,this.envMapRotation.copy(e.envMapRotation),this.combine=e.combine,this.reflectivity=e.reflectivity,this.envMapIntensity=e.envMapIntensity,this.refractionRatio=e.refractionRatio,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.wireframeLinecap=e.wireframeLinecap,this.wireframeLinejoin=e.wireframeLinejoin,this.flatShading=e.flatShading,this.fog=e.fog,this}},ec=class extends an{constructor(e){super(),this.isMeshToonMaterial=!0,this.defines={TOON:""},this.type="MeshToonMaterial",this.color=new be(16777215),this.map=null,this.gradientMap=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.emissive=new be(0),this.emissiveIntensity=1,this.emissiveMap=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=nr,this.normalScale=new he(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.alphaMap=null,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.gradientMap=e.gradientMap,this.lightMap=e.lightMap,this.lightMapIntensity=e.lightMapIntensity,this.aoMap=e.aoMap,this.aoMapIntensity=e.aoMapIntensity,this.emissive.copy(e.emissive),this.emissiveMap=e.emissiveMap,this.emissiveIntensity=e.emissiveIntensity,this.bumpMap=e.bumpMap,this.bumpScale=e.bumpScale,this.normalMap=e.normalMap,this.normalMapType=e.normalMapType,this.normalScale.copy(e.normalScale),this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.alphaMap=e.alphaMap,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.wireframeLinecap=e.wireframeLinecap,this.wireframeLinejoin=e.wireframeLinejoin,this.fog=e.fog,this}},tc=class extends an{constructor(e){super(),this.isMeshNormalMaterial=!0,this.type="MeshNormalMaterial",this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=nr,this.normalScale=new he(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.wireframe=!1,this.wireframeLinewidth=1,this.flatShading=!1,this.setValues(e)}copy(e){return super.copy(e),this.bumpMap=e.bumpMap,this.bumpScale=e.bumpScale,this.normalMap=e.normalMap,this.normalMapType=e.normalMapType,this.normalScale.copy(e.normalScale),this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.flatShading=e.flatShading,this}},nc=class extends an{constructor(e){super(),this.isMeshLambertMaterial=!0,this.type="MeshLambertMaterial",this.color=new be(16777215),this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.emissive=new be(0),this.emissiveIntensity=1,this.emissiveMap=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=nr,this.normalScale=new he(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.specularMap=null,this.alphaMap=null,this.envMap=null,this.envMapRotation=new Vn,this.combine=fa,this.reflectivity=1,this.envMapIntensity=1,this.refractionRatio=.98,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.flatShading=!1,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.lightMap=e.lightMap,this.lightMapIntensity=e.lightMapIntensity,this.aoMap=e.aoMap,this.aoMapIntensity=e.aoMapIntensity,this.emissive.copy(e.emissive),this.emissiveMap=e.emissiveMap,this.emissiveIntensity=e.emissiveIntensity,this.bumpMap=e.bumpMap,this.bumpScale=e.bumpScale,this.normalMap=e.normalMap,this.normalMapType=e.normalMapType,this.normalScale.copy(e.normalScale),this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.specularMap=e.specularMap,this.alphaMap=e.alphaMap,this.envMap=e.envMap,this.envMapRotation.copy(e.envMapRotation),this.combine=e.combine,this.reflectivity=e.reflectivity,this.envMapIntensity=e.envMapIntensity,this.refractionRatio=e.refractionRatio,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.wireframeLinecap=e.wireframeLinecap,this.wireframeLinejoin=e.wireframeLinejoin,this.flatShading=e.flatShading,this.fog=e.fog,this}},ia=class extends an{constructor(e){super(),this.isMeshDepthMaterial=!0,this.type="MeshDepthMaterial",this.depthPacking=rm,this.map=null,this.alphaMap=null,this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.wireframe=!1,this.wireframeLinewidth=1,this.setValues(e)}copy(e){return super.copy(e),this.depthPacking=e.depthPacking,this.map=e.map,this.alphaMap=e.alphaMap,this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this}},ra=class extends an{constructor(e){super(),this.isMeshDistanceMaterial=!0,this.type="MeshDistanceMaterial",this.map=null,this.alphaMap=null,this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.setValues(e)}copy(e){return super.copy(e),this.map=e.map,this.alphaMap=e.alphaMap,this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this}},ic=class extends an{constructor(e){super(),this.isMeshMatcapMaterial=!0,this.defines={MATCAP:""},this.type="MeshMatcapMaterial",this.color=new be(16777215),this.matcap=null,this.map=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=nr,this.normalScale=new he(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.alphaMap=null,this.wireframe=!1,this.wireframeLinewidth=1,this.flatShading=!1,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.defines={MATCAP:""},this.color.copy(e.color),this.matcap=e.matcap,this.map=e.map,this.bumpMap=e.bumpMap,this.bumpScale=e.bumpScale,this.normalMap=e.normalMap,this.normalMapType=e.normalMapType,this.normalScale.copy(e.normalScale),this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.alphaMap=e.alphaMap,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.flatShading=e.flatShading,this.fog=e.fog,this}},rc=class extends dn{constructor(e){super(),this.isLineDashedMaterial=!0,this.type="LineDashedMaterial",this.scale=1,this.dashSize=3,this.gapSize=1,this.setValues(e)}copy(e){return super.copy(e),this.scale=e.scale,this.dashSize=e.dashSize,this.gapSize=e.gapSize,this}};function Di(i,e){return!i||i.constructor===e?i:typeof e.BYTES_PER_ELEMENT=="number"?new e(i):Array.prototype.slice.call(i)}function pl(i){return i!==void 0&&i.inTangents!==void 0&&i.outTangents!==void 0}function Fv(i){function e(r,s){return i[r]-i[s]}let t=i.length,n=new Array(t);for(let r=0;r!==t;++r)n[r]=r;return n.sort(e),n}function _p(i,e,t){let n=i.length,r=new i.constructor(n);for(let s=0,o=0;o!==n;++s){let a=t[s]*e;for(let l=0;l!==e;++l)r[o++]=i[a+l]}return r}function Uv(i,e,t,n){let r=1,s=i[0];for(;s!==void 0&&s[n]===void 0;)s=i[r++];if(s===void 0)return;let o=s[n];if(o!==void 0)if(Array.isArray(o))do o=s[n],o!==void 0&&(e.push(s.time),t.push(...o)),s=i[r++];while(s!==void 0);else if(o.toArray!==void 0)do o=s[n],o!==void 0&&(e.push(s.time),o.toArray(t,t.length)),s=i[r++];while(s!==void 0);else do o=s[n],o!==void 0&&(e.push(s.time),t.push(o)),s=i[r++];while(s!==void 0)}function n1(i,e,t,n,r=30){let s=i.clone();s.name=e;let o=[];for(let l=0;l<s.tracks.length;++l){let c=s.tracks[l],u=c.getValueSize(),f=[],h=[];for(let d=0;d<c.times.length;++d){let p=c.times[d]*r;if(!(p<t||p>=n)){f.push(c.times[d]);for(let v=0;v<u;++v)h.push(c.values[d*u+v])}}f.length!==0&&(c.times=Di(f,c.times.constructor),c.values=Di(h,c.values.constructor),o.push(c))}s.tracks=o;let a=1/0;for(let l=0;l<s.tracks.length;++l)a>s.tracks[l].times[0]&&(a=s.tracks[l].times[0]);for(let l=0;l<s.tracks.length;++l)s.tracks[l].shift(-1*a);return s.resetDuration(),s}function i1(i,e=0,t=i,n=30){n<=0&&(n=30);let r=t.tracks.length,s=e/n;for(let o=0;o<r;++o){let a=t.tracks[o],l=a.ValueTypeName;if(l==="bool"||l==="string")continue;let c=i.tracks.find(function(m){return m.name===a.name&&m.ValueTypeName===l});if(c===void 0)continue;let u=0,f=a.getValueSize();a.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline&&(u=f/3);let h=0,d=c.getValueSize();c.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline&&(h=d/3);let p=a.times.length-1,v;if(s<=a.times[0]){let m=u,y=f-u;v=a.values.slice(m,y)}else if(s>=a.times[p]){let m=p*f+u,y=m+f-u;v=a.values.slice(m,y)}else{let m=a.createInterpolant(),y=u,_=f-u;m.evaluate(s),v=m.resultBuffer.slice(y,_)}l==="quaternion"&&new Jt().fromArray(v).normalize().conjugate().toArray(v);let g=c.times.length;for(let m=0;m<g;++m){let y=m*d+h;if(l==="quaternion")Jt.multiplyQuaternionsFlat(c.values,y,v,0,c.values,y);else{let _=d-h*2;for(let x=0;x<_;++x)c.values[y+x]-=v[x]}}}return i.blendMode=Yf,i}var Xh=class{static convertArray(e,t){return Di(e,t)}static isTypedArray(e){return bv(e)}static hasTangents(e){return pl(e)}static getKeyframeOrder(e){return Fv(e)}static sortedArray(e,t,n){return _p(e,t,n)}static flattenJSON(e,t,n,r){Uv(e,t,n,r)}static subclip(e,t,n,r,s=30){return n1(e,t,n,r,s)}static makeClipAdditive(e,t=0,n=e,r=30){return i1(e,t,n,r)}},Tr=class{constructor(e,t,n,r){this.parameterPositions=e,this._cachedIndex=0,this.resultBuffer=r!==void 0?r:new t.constructor(n),this.sampleValues=t,this.valueSize=n,this.settings=null,this.DefaultSettings_={}}evaluate(e){let t=this.parameterPositions,n=this._cachedIndex,r=t[n],s=t[n-1];e:{t:{let o;n:{i:if(!(e<r)){for(let a=n+2;;){if(r===void 0){if(e<s)break i;return n=t.length,this._cachedIndex=n,this.copySampleValue_(n-1)}if(n===a)break;if(s=r,r=t[++n],e<r)break t}o=t.length;break n}if(!(e>=s)){let a=t[1];e<a&&(n=2,s=a);for(let l=n-2;;){if(s===void 0)return this._cachedIndex=0,this.copySampleValue_(0);if(n===l)break;if(r=s,s=t[--n-1],e>=s)break t}o=n,n=0;break n}break e}for(;n<o;){let a=n+o>>>1;e<t[a]?o=a:n=a+1}if(r=t[n],s=t[n-1],s===void 0)return this._cachedIndex=0,this.copySampleValue_(0);if(r===void 0)return n=t.length,this._cachedIndex=n,this.copySampleValue_(n-1)}this._cachedIndex=n,this.intervalChanged_(n,s,r)}return this.interpolate_(n,s,e,r)}getSettings_(){return this.settings||this.DefaultSettings_}copySampleValue_(e){let t=this.resultBuffer,n=this.sampleValues,r=this.valueSize,s=e*r;for(let o=0;o!==r;++o)t[o]=n[s+o];return t}interpolate_(){throw new Error("THREE.Interpolant: Call to abstract method.")}intervalChanged_(){}},sc=class extends Tr{constructor(e,t,n,r){super(e,t,n,r),this._weightPrev=-0,this._offsetPrev=-0,this._weightNext=-0,this._offsetNext=-0,this.DefaultSettings_={endingStart:Xr,endingEnd:Xr}}intervalChanged_(e,t,n){let r=this.parameterPositions,s=e-2,o=e+1,a=r[s],l=r[o];if(a===void 0)switch(this.getSettings_().endingStart){case qr:s=e,a=2*t-n;break;case Bo:s=r.length-2,a=t+r[s]-r[s+1];break;default:s=e,a=n}if(l===void 0)switch(this.getSettings_().endingEnd){case qr:o=e,l=2*n-t;break;case Bo:o=1,l=n+r[1]-r[0];break;default:o=e-1,l=t}let c=(n-t)*.5,u=this.valueSize;this._weightPrev=c/(t-a),this._weightNext=c/(l-n),this._offsetPrev=s*u,this._offsetNext=o*u}interpolate_(e,t,n,r){let s=this.resultBuffer,o=this.sampleValues,a=this.valueSize,l=e*a,c=l-a,u=this._offsetPrev,f=this._offsetNext,h=this._weightPrev,d=this._weightNext,p=(n-t)/(r-t),v=p*p,g=v*p,m=-h*g+2*h*v-h*p,y=(1+h)*g+(-1.5-2*h)*v+(-.5+h)*p+1,_=(-1-d)*g+(1.5+d)*v+.5*p,x=d*g-d*v;for(let S=0;S!==a;++S)s[S]=m*o[u+S]+y*o[c+S]+_*o[l+S]+x*o[f+S];return s}},sa=class extends Tr{constructor(e,t,n,r){super(e,t,n,r)}interpolate_(e,t,n,r){let s=this.resultBuffer,o=this.sampleValues,a=this.valueSize,l=e*a,c=l-a,u=(n-t)/(r-t),f=1-u;for(let h=0;h!==a;++h)s[h]=o[c+h]*f+o[l+h]*u;return s}},oc=class extends Tr{constructor(e,t,n,r){super(e,t,n,r)}interpolate_(e){return this.copySampleValue_(e-1)}},ac=class extends Tr{interpolate_(e,t,n,r){let s=this.resultBuffer,o=this.sampleValues,a=this.valueSize,l=e*a,c=l-a,u=this.inTangents,f=this.outTangents;if(!u||!f){let p=(n-t)/(r-t),v=1-p;for(let g=0;g!==a;++g)s[g]=o[c+g]*v+o[l+g]*p;return s}let h=a*2,d=e-1;for(let p=0;p!==a;++p){let v=o[c+p],g=o[l+p],m=d*h+p*2,y=f[m],_=f[m+1],x=e*h+p*2,S=u[x],b=u[x+1],E=s1(n,t,y,S,r);s[p]=Bv(E,v,_,b,g)}return s}};function Bv(i,e,t,n,r){let s=1-i;return s*s*s*e+3*s*s*i*t+3*s*i*i*n+i*i*i*r}function r1(i,e,t,n,r){let s=1-i;return 3*s*s*(t-e)+6*s*i*(n-t)+3*i*i*(r-n)}function s1(i,e,t,n,r){let s=(i-e)/(r-e);for(let o=0;o<8;o++){let a=Bv(s,e,t,n,r)-i;if(Math.abs(a)<1e-10)break;let l=r1(s,e,t,n,r);if(Math.abs(l)<1e-10)break;s=Math.max(0,Math.min(1,s-a/l))}return s}var Wn=class{constructor(e,t,n,r){if(e===void 0)throw new Error("THREE.KeyframeTrack: track name is undefined");if(t===void 0||t.length===0)throw new Error("THREE.KeyframeTrack: no keyframes in track named "+e);this.name=e,this.times=Di(t,this.TimeBufferType),this.values=Di(n,this.ValueBufferType),this.setInterpolation(r||this.DefaultInterpolation)}static toJSON(e){let t=e.constructor,n;if(t.toJSON!==this.toJSON)n=t.toJSON(e);else{n={name:e.name,times:Di(e.times,Array),values:Di(e.values,Array)};let r=e.getInterpolation();r!==e.DefaultInterpolation&&(n.interpolation=r),pl(e.settings)&&(n.settings={inTangents:Di(e.settings.inTangents,Array),outTangents:Di(e.settings.outTangents,Array)})}return n.type=e.ValueTypeName,n}InterpolantFactoryMethodDiscrete(e){return new oc(this.times,this.values,this.getValueSize(),e)}InterpolantFactoryMethodLinear(e){return new sa(this.times,this.values,this.getValueSize(),e)}InterpolantFactoryMethodSmooth(e){return new sc(this.times,this.values,this.getValueSize(),e)}InterpolantFactoryMethodBezier(e){let t=new ac(this.times,this.values,this.getValueSize(),e);return this.settings&&(t.inTangents=this.settings.inTangents,t.outTangents=this.settings.outTangents),t}setInterpolation(e){let t;switch(e){case Uo:t=this.InterpolantFactoryMethodDiscrete;break;case Sl:t=this.InterpolantFactoryMethodLinear;break;case cl:t=this.InterpolantFactoryMethodSmooth;break;case Ah:t=this.InterpolantFactoryMethodBezier;break}if(t===void 0){let n="unsupported interpolation for "+this.ValueTypeName+" keyframe track named "+this.name;if(this.createInterpolant===void 0)if(e!==this.DefaultInterpolation)this.setInterpolation(this.DefaultInterpolation);else throw new Error(n);return Ge("KeyframeTrack:",n),this}return this.createInterpolant=t,this}getInterpolation(){switch(this.createInterpolant){case this.InterpolantFactoryMethodDiscrete:return Uo;case this.InterpolantFactoryMethodLinear:return Sl;case this.InterpolantFactoryMethodSmooth:return cl;case this.InterpolantFactoryMethodBezier:return Ah}}getValueSize(){return this.values.length/this.times.length}shift(e){if(e!==0){let t=this.times;for(let n=0,r=t.length;n!==r;++n)t[n]+=e}return this}scale(e){if(e!==1){let t=this.times;for(let n=0,r=t.length;n!==r;++n)t[n]*=e;pl(this.settings)&&(fg(this.settings.inTangents,e),fg(this.settings.outTangents,e))}return this}trim(e,t){let n=this.times,r=n.length,s=0,o=r-1;for(;s!==r&&n[s]<e;)++s;for(;o!==-1&&n[o]>t;)--o;if(++o,s!==0||o!==r){s>=o&&(o=Math.max(o,1),s=o-1);let a=this.getValueSize();this.times=n.slice(s,o),this.values=this.values.slice(s*a,o*a)}return this}validate(){let e=!0,t=this.getValueSize();t-Math.floor(t)!==0&&(Qe("KeyframeTrack: Invalid value size in track.",this),e=!1);let n=this.times,r=this.values,s=n.length;s===0&&(Qe("KeyframeTrack: Track is empty.",this),e=!1);let o=null;for(let a=0;a!==s;a++){let l=n[a];if(typeof l=="number"&&isNaN(l)){Qe("KeyframeTrack: Time is not a valid number.",this,a,l),e=!1;break}if(o!==null&&o>l){Qe("KeyframeTrack: Out of order keys.",this,a,l,o),e=!1;break}o=l}if(r!==void 0&&bv(r))for(let a=0,l=r.length;a!==l;++a){let c=r[a];if(isNaN(c)){Qe("KeyframeTrack: Value is not a valid number.",this,a,c),e=!1;break}}return e}optimize(){let e=this.times.slice(),t=this.values.slice(),n=this.getValueSize(),r=this.getInterpolation()===cl,s=e.length-1,o=1;for(let a=1;a<s;++a){let l=!1,c=e[a],u=e[a+1];if(c!==u&&(a!==1||c!==e[0]))if(r)l=!0;else{let f=a*n,h=f-n,d=f+n;for(let p=0;p!==n;++p){let v=t[f+p];if(v!==t[h+p]||v!==t[d+p]){l=!0;break}}}if(l){if(a!==o){e[o]=e[a];let f=a*n,h=o*n;for(let d=0;d!==n;++d)t[h+d]=t[f+d]}++o}}if(s>0){e[o]=e[s];for(let a=s*n,l=o*n,c=0;c!==n;++c)t[l+c]=t[a+c];++o}return o!==e.length?(this.times=e.slice(0,o),this.values=t.slice(0,o*n)):(this.times=e,this.values=t),this}clone(){let e=this.times.slice(),t=this.values.slice(),n=this.constructor,r=new n(this.name,e,t);return r.createInterpolant=this.createInterpolant,pl(this.settings)&&(r.settings={inTangents:this.settings.inTangents.slice(),outTangents:this.settings.outTangents.slice()}),r}};function fg(i,e){for(let t=0,n=i.length;t!==n;t+=2)i[t]*=e}Wn.prototype.ValueTypeName="";Wn.prototype.TimeBufferType=Float32Array;Wn.prototype.ValueBufferType=Float32Array;Wn.prototype.DefaultInterpolation=Sl;var Qi=class extends Wn{constructor(e,t,n){super(e,t,n)}};Qi.prototype.ValueTypeName="bool";Qi.prototype.ValueBufferType=Array;Qi.prototype.DefaultInterpolation=Uo;Qi.prototype.InterpolantFactoryMethodLinear=void 0;Qi.prototype.InterpolantFactoryMethodSmooth=void 0;var oa=class extends Wn{constructor(e,t,n,r){super(e,t,n,r)}};oa.prototype.ValueTypeName="color";var zs=class extends Wn{constructor(e,t,n,r){super(e,t,n,r)}};zs.prototype.ValueTypeName="number";var lc=class extends Tr{constructor(e,t,n,r){super(e,t,n,r)}interpolate_(e,t,n,r){let s=this.resultBuffer,o=this.sampleValues,a=this.valueSize,l=(n-t)/(r-t),c=e*a;for(let u=c+a;c!==u;c+=4)Jt.slerpFlat(s,0,o,c-a,o,c,l);return s}},ks=class extends Wn{constructor(e,t,n,r){super(e,t,n,r)}InterpolantFactoryMethodLinear(e){return new lc(this.times,this.values,this.getValueSize(),e)}};ks.prototype.ValueTypeName="quaternion";ks.prototype.InterpolantFactoryMethodSmooth=void 0;var er=class extends Wn{constructor(e,t,n){super(e,t,n)}};er.prototype.ValueTypeName="string";er.prototype.ValueBufferType=Array;er.prototype.DefaultInterpolation=Uo;er.prototype.InterpolantFactoryMethodLinear=void 0;er.prototype.InterpolantFactoryMethodSmooth=void 0;var aa=class extends Wn{constructor(e,t,n,r){super(e,t,n,r)}};aa.prototype.ValueTypeName="vector";var es=class{constructor(e="",t=-1,n=[],r=su){this.name=e,this.tracks=n,this.duration=t,this.blendMode=r,this.uuid=ai(),this.userData={},this.duration<0&&this.resetDuration()}static parse(e){let t=[],n=e.tracks,r=1/(e.fps||1);for(let o=0,a=n.length;o!==a;++o)t.push(a1(n[o]).scale(r));let s=new this(e.name,e.duration,t,e.blendMode);return s.uuid=e.uuid,s.userData=JSON.parse(e.userData||"{}"),s}static toJSON(e){let t=[],n=e.tracks,r={name:e.name,duration:e.duration,tracks:t,uuid:e.uuid,blendMode:e.blendMode,userData:JSON.stringify(e.userData)};for(let s=0,o=n.length;s!==o;++s)t.push(Wn.toJSON(n[s]));return r}static CreateFromMorphTargetSequence(e,t,n,r){let s=t.length,o=[];for(let a=0;a<s;a++){let l=[],c=[];l.push((a+s-1)%s,a,(a+1)%s),c.push(0,1,0);let u=Fv(l);l=_p(l,1,u),c=_p(c,1,u),!r&&l[0]===0&&(l.push(s),c.push(c[0])),o.push(new zs(".morphTargetInfluences["+t[a].name+"]",l,c).scale(1/n))}return new this(e,-1,o)}static findByName(e,t){let n=e;if(!Array.isArray(e)){let r=e;n=r.geometry&&r.geometry.animations||r.animations}for(let r=0;r<n.length;r++)if(n[r].name===t)return n[r];return null}static CreateClipsFromMorphTargetSequences(e,t,n){let r={},s=/^([\w-]*?)([\d]+)$/;for(let a=0,l=e.length;a<l;a++){let c=e[a],u=c.name.match(s);if(u&&u.length>1){let f=u[1],h=r[f];h||(r[f]=h=[]),h.push(c)}}let o=[];for(let a in r)o.push(this.CreateFromMorphTargetSequence(a,r[a],t,n));return o}resetDuration(){let e=this.tracks,t=0;for(let n=0,r=e.length;n!==r;++n){let s=this.tracks[n];t=Math.max(t,s.times[s.times.length-1])}return this.duration=t,this}trim(){for(let e=0;e<this.tracks.length;e++)this.tracks[e].trim(0,this.duration);return this}validate(){let e=!0;for(let t=0;t<this.tracks.length;t++)e=e&&this.tracks[t].validate();return e}optimize(){for(let e=0;e<this.tracks.length;e++)this.tracks[e].optimize();return this}clone(){let e=[];for(let n=0;n<this.tracks.length;n++)e.push(this.tracks[n].clone());let t=new this.constructor(this.name,this.duration,e,this.blendMode);return t.userData=JSON.parse(JSON.stringify(this.userData)),t}toJSON(){return this.constructor.toJSON(this)}};function o1(i){switch(i.toLowerCase()){case"scalar":case"double":case"float":case"number":case"integer":return zs;case"vector":case"vector2":case"vector3":case"vector4":return aa;case"color":return oa;case"quaternion":return ks;case"bool":case"boolean":return Qi;case"string":return er}throw new Error("THREE.KeyframeTrack: Unsupported typeName: "+i)}function a1(i){if(i.type===void 0)throw new Error("THREE.KeyframeTrack: track type undefined, can not parse");let e=o1(i.type);if(i.times===void 0){let n=[],r=[];Uv(i.keys,n,r,"value"),i.times=n,i.values=r}let t;return e.parse!==void 0?t=e.parse(i):t=new e(i.name,i.times,i.values,i.interpolation),pl(i.settings)&&(t.settings={inTangents:Di(i.settings.inTangents,Float32Array),outTangents:Di(i.settings.outTangents,Float32Array)}),t}var Fi={enabled:!1,files:{},add:function(i,e){this.enabled!==!1&&(dg(i)||(this.files[i]=e))},get:function(i){if(this.enabled!==!1&&!dg(i))return this.files[i]},remove:function(i){delete this.files[i]},clear:function(){this.files={}}};function dg(i){try{let e=i.slice(i.indexOf(":")+1);return new URL(e).protocol==="blob:"}catch{return!1}}var la=class{constructor(e,t,n){let r=this,s=!1,o=0,a=0,l,c=[];this.onStart=void 0,this.onLoad=e,this.onProgress=t,this.onError=n,this._abortController=null,this.itemStart=function(u){a++,s===!1&&r.onStart!==void 0&&r.onStart(u,o,a),s=!0},this.itemEnd=function(u){o++,r.onProgress!==void 0&&r.onProgress(u,o,a),o===a&&(s=!1,r.onLoad!==void 0&&r.onLoad())},this.itemError=function(u){r.onError!==void 0&&r.onError(u)},this.resolveURL=function(u){return u=u.normalize("NFC"),l?l(u):u},this.setURLModifier=function(u){return l=u,this},this.addHandler=function(u,f){return c.push(u,f),this},this.removeHandler=function(u){let f=c.indexOf(u);return f!==-1&&c.splice(f,2),this},this.getHandler=function(u){for(let f=0,h=c.length;f<h;f+=2){let d=c[f],p=c[f+1];if(d.global&&(d.lastIndex=0),d.test(u))return p}return null},this.abort=function(){return this.abortController.abort(),this._abortController=null,this}}get abortController(){return this._abortController||(this._abortController=new AbortController),this._abortController}},vm=new la,_n=class{constructor(e){this.manager=e!==void 0?e:vm,this.crossOrigin="anonymous",this.withCredentials=!1,this.path="",this.resourcePath="",this.requestHeader={},typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}load(){}loadAsync(e,t){let n=this;return new Promise(function(r,s){n.load(e,r,t,s)})}parse(){}setCrossOrigin(e){return this.crossOrigin=e,this}setWithCredentials(e){return this.withCredentials=e,this}setPath(e){return this.path=e,this}setResourcePath(e){return this.resourcePath=e,this}setRequestHeader(e){return this.requestHeader=e,this}abort(){return this}};_n.DEFAULT_MATERIAL_NAME="__DEFAULT";var vr={},Mp=class extends Error{constructor(e,t){super(e),this.response=t}},Ai=class extends _n{constructor(e){super(e),this.mimeType="",this.responseType="",this._abortController=new AbortController}load(e,t,n,r){e===void 0&&(e=""),this.path!==void 0&&(e=this.path+e),e=this.manager.resolveURL(e);let s=Fi.get(`file:${e}`);if(s!==void 0){this.manager.itemStart(e),setTimeout(()=>{t&&t(s),this.manager.itemEnd(e)},0);return}if(vr[e]!==void 0){vr[e].push({onLoad:t,onProgress:n,onError:r});return}vr[e]=[],vr[e].push({onLoad:t,onProgress:n,onError:r});let o=new Request(e,{headers:new Headers(this.requestHeader),credentials:this.withCredentials?"include":"same-origin",signal:typeof AbortSignal.any=="function"?AbortSignal.any([this._abortController.signal,this.manager.abortController.signal]):this._abortController.signal}),a=this.mimeType,l=this.responseType;fetch(o).then(c=>{if(c.status===200||c.status===0){if(c.status===0&&Ge("FileLoader: HTTP Status 0 received."),typeof ReadableStream>"u"||c.body===void 0||c.body.getReader===void 0)return c;let u=vr[e],f=c.body.getReader(),h=c.headers.get("X-File-Size")||c.headers.get("Content-Length"),d=h?parseInt(h):0,p=d!==0,v=0,g=new ReadableStream({start(m){y();function y(){f.read().then(({done:_,value:x})=>{if(_)m.close();else{v+=x.byteLength;let S=new ProgressEvent("progress",{lengthComputable:p,loaded:v,total:d});for(let b=0,E=u.length;b<E;b++){let M=u[b];M.onProgress&&M.onProgress(S)}m.enqueue(x),y()}},_=>{m.error(_)})}}});return new Response(g)}else throw new Mp(`fetch for "${c.url}" responded with ${c.status}: ${c.statusText}`,c)}).then(c=>{switch(l){case"arraybuffer":return c.arrayBuffer();case"blob":return c.blob();case"document":return c.text().then(u=>new DOMParser().parseFromString(u,a));case"json":return c.json();default:if(a==="")return c.text();{let f=/charset="?([^;"\s]*)"?/i.exec(a),h=f&&f[1]?f[1].toLowerCase():void 0,d=new TextDecoder(h);return c.arrayBuffer().then(p=>d.decode(p))}}}).then(c=>{Fi.add(`file:${e}`,c);let u=vr[e];delete vr[e];for(let f=0,h=u.length;f<h;f++){let d=u[f];d.onLoad&&d.onLoad(c)}}).catch(c=>{let u=vr[e];if(u===void 0)throw this.manager.itemError(e),c;delete vr[e];for(let f=0,h=u.length;f<h;f++){let d=u[f];d.onError&&d.onError(c)}this.manager.itemError(e)}).finally(()=>{this.manager.itemEnd(e)}),this.manager.itemStart(e)}setResponseType(e){return this.responseType=e,this}setMimeType(e){return this.mimeType=e,this}abort(){return this._abortController.abort(),this._abortController=new AbortController,this}},qh=class extends _n{constructor(e){super(e)}load(e,t,n,r){let s=this,o=new Ai(this.manager);o.setPath(this.path),o.setRequestHeader(this.requestHeader),o.setWithCredentials(this.withCredentials),o.load(e,function(a){try{t(s.parse(JSON.parse(a)))}catch(l){r?r(l):Qe(l),s.manager.itemError(e)}},n,r)}parse(e){let t=[];for(let n=0;n<e.length;n++){let r=es.parse(e[n]);t.push(r)}return t}},Yh=class extends _n{constructor(e){super(e)}load(e,t,n,r){let s=this,o=[],a=new Ls,l=new Ai(this.manager);l.setPath(this.path),l.setResponseType("arraybuffer"),l.setRequestHeader(this.requestHeader),l.setWithCredentials(s.withCredentials);let c=0;function u(f){l.load(e[f],function(h){let d=s.parse(h,!0);o[f]={width:d.width,height:d.height,format:d.format,mipmaps:d.mipmaps},c+=1,c===6&&(d.mipmapCount===1&&(a.minFilter=zt),a.image=o,a.format=d.format,a.needsUpdate=!0,t&&t(a))},n,r)}if(Array.isArray(e))for(let f=0,h=e.length;f<h;++f)u(f);else l.load(e,function(f){let h=s.parse(f,!0);if(h.isCubemap){let d=h.mipmaps.length/h.mipmapCount;for(let p=0;p<d;p++){o[p]={mipmaps:[]};for(let v=0;v<h.mipmapCount;v++)o[p].mipmaps.push(h.mipmaps[p*h.mipmapCount+v]),o[p].format=h.format,o[p].width=h.width,o[p].height=h.height}a.image=o}else a.image.width=h.width,a.image.height=h.height,a.mipmaps=h.mipmaps;h.mipmapCount===1&&(a.minFilter=zt),a.format=h.format,a.needsUpdate=!0,t&&t(a)},n,r);return a}},Co=new WeakMap,ts=class extends _n{constructor(e){super(e)}load(e,t,n,r){this.path!==void 0&&(e=this.path+e),e=this.manager.resolveURL(e);let s=this,o=Fi.get(`image:${e}`);if(o!==void 0){if(o.complete===!0)s.manager.itemStart(e),setTimeout(function(){t&&t(o),s.manager.itemEnd(e)},0);else{let f=Co.get(o);f===void 0&&(f=[],Co.set(o,f)),f.push({onLoad:t,onError:r})}return o}let a=ko("img");function l(){u(),t&&t(this);let f=Co.get(this)||[];for(let h=0;h<f.length;h++){let d=f[h];d.onLoad&&d.onLoad(this)}Co.delete(this),s.manager.itemEnd(e)}function c(f){u(),r&&r(f),Fi.remove(`image:${e}`);let h=Co.get(this)||[];for(let d=0;d<h.length;d++){let p=h[d];p.onError&&p.onError(f)}Co.delete(this),s.manager.itemError(e),s.manager.itemEnd(e)}function u(){a.removeEventListener("load",l,!1),a.removeEventListener("error",c,!1)}return a.addEventListener("load",l,!1),a.addEventListener("error",c,!1),e.slice(0,5)!=="data:"&&this.crossOrigin!==void 0&&(a.crossOrigin=this.crossOrigin),Fi.add(`image:${e}`,a),s.manager.itemStart(e),a.src=e,a}},Zh=class extends _n{constructor(e){super(e)}load(e,t,n,r){let s=new Kr;s.colorSpace=nn;let o=new ts(this.manager);o.setCrossOrigin(this.crossOrigin),o.setPath(this.path);let a=0;function l(c){o.load(e[c],function(u){s.images[c]=u,a++,a===6&&(s.needsUpdate=!0,t&&t(s))},void 0,r)}for(let c=0;c<e.length;++c)l(c);return s}},$h=class extends _n{constructor(e){super(e)}load(e,t,n,r){let s=this,o=new Gn,a=new Ai(this.manager);return a.setResponseType("arraybuffer"),a.setRequestHeader(this.requestHeader),a.setPath(this.path),a.setWithCredentials(s.withCredentials),a.load(e,function(l){let c;try{c=s.parse(l)}catch(u){r!==void 0?r(u):Qe(u);return}s._applyTexData(o,c),t&&t(o,c)},n,r),o}createDataTexture(e){let t=new Gn;return this._applyTexData(t,this.parse(e)),t}_applyTexData(e,t){t.image!==void 0?e.image=t.image:t.data!==void 0&&(e.image.width=t.width,e.image.height=t.height,e.image.data=t.data),e.wrapS=t.wrapS!==void 0?t.wrapS:zn,e.wrapT=t.wrapT!==void 0?t.wrapT:zn,e.magFilter=t.magFilter!==void 0?t.magFilter:zt,e.minFilter=t.minFilter!==void 0?t.minFilter:zt,e.anisotropy=t.anisotropy!==void 0?t.anisotropy:1,t.colorSpace!==void 0&&(e.colorSpace=t.colorSpace),t.flipY!==void 0&&(e.flipY=t.flipY),t.format!==void 0&&(e.format=t.format),t.type!==void 0&&(e.type=t.type),t.mipmaps!==void 0&&(e.mipmaps=t.mipmaps,e.minFilter=ki),t.mipmapCount===1&&(e.minFilter=zt),t.generateMipmaps!==void 0&&(e.generateMipmaps=t.generateMipmaps),e.needsUpdate=!0}},Jh=class extends _n{constructor(e){super(e)}load(e,t,n,r){let s=new jt,o=new ts(this.manager);return o.setCrossOrigin(this.crossOrigin),o.setPath(this.path),o.load(e,function(a){s.image=a,s.needsUpdate=!0,t!==void 0&&t(s)},n,r),s}},Oi=class extends At{constructor(e,t=1){super(),this.isLight=!0,this.type="Light",this.color=new be(e),this.intensity=t}copy(e,t){return super.copy(e,t),this.color.copy(e.color),this.intensity=e.intensity,this}toJSON(e){let t=super.toJSON(e);return t.object.color=this.color.getHex(),t.object.intensity=this.intensity,t}},Gs=class extends Oi{constructor(e,t,n){super(e,n),this.isHemisphereLight=!0,this.type="HemisphereLight",this.position.copy(At.DEFAULT_UP),this.updateMatrix(),this.groundColor=new be(t)}copy(e,t){return super.copy(e,t),this.groundColor.copy(e.groundColor),this}toJSON(e){let t=super.toJSON(e);return t.object.groundColor=this.groundColor.getHex(),t}},lp=new it,pg=new R,mg=new R,Vs=class{constructor(e){this.camera=e,this.intensity=1,this.bias=0,this.biasNode=null,this.normalBias=0,this.radius=1,this.blurSamples=8,this.mapSize=new he(512,512),this.mapType=Xn,this.map=null,this.mapPass=null,this.matrix=new it,this.autoUpdate=!0,this.needsUpdate=!1,this._frustum=new Ki,this._frameExtents=new he(1,1),this._viewportCount=1,this._viewports=[new Pt(0,0,1,1)]}getViewportCount(){return this._viewportCount}getCamera(){return this.camera}getFrustum(){return this._frustum}updateMatrices(e){let t=this.camera;pg.setFromMatrixPosition(e.matrixWorld),t.position.copy(pg),mg.setFromMatrixPosition(e.target.matrixWorld),t.lookAt(mg),t.updateMatrixWorld(),this._updateMatrix(t,this.matrix,this._frustum)}_updateMatrix(e,t,n,r){lp.multiplyMatrices(e.projectionMatrix,e.matrixWorldInverse),n.setFromProjectionMatrix(lp,e.coordinateSystem,e.reversedDepth);let s=this._frameExtents,o=r?r.z/s.x:1,a=r?r.w/s.y:1,l=r?r.x/s.x:0,c=r?r.y/s.y:0;e.coordinateSystem===Zr||e.reversedDepth?t.set(.5*o,0,0,.5*o+l,0,.5*a,0,.5*a+c,0,0,1,0,0,0,0,1):t.set(.5*o,0,0,.5*o+l,0,.5*a,0,.5*a+c,0,0,.5,.5,0,0,0,1),t.multiply(lp)}getViewport(e){return this._viewports[e]}getFrameExtents(){return this._frameExtents}dispose(){this.map&&this.map.dispose(),this.mapPass&&this.mapPass.dispose()}copy(e){return this.camera=e.camera.clone(),this.intensity=e.intensity,this.bias=e.bias,this.radius=e.radius,this.autoUpdate=e.autoUpdate,this.needsUpdate=e.needsUpdate,this.normalBias=e.normalBias,this.blurSamples=e.blurSamples,this.mapSize.copy(e.mapSize),this.biasNode=e.biasNode,this}clone(){return new this.constructor().copy(this)}toJSON(){let e={};return e.intensity=this.intensity,e.bias=this.bias,e.normalBias=this.normalBias,e.radius=this.radius,e.blurSamples=this.blurSamples,e.mapSize=this.mapSize.toArray(),e.camera=this.camera.toJSON(!1).object,delete e.camera.matrix,e}},gh=new R,vh=new Jt,Zi=new R,Hs=class extends At{constructor(){super(),this.isCamera=!0,this.type="Camera",this.matrixWorldInverse=new it,this.projectionMatrix=new it,this.projectionMatrixInverse=new it,this.coordinateSystem=Kn,this._reversedDepth=!1}get reversedDepth(){return this._reversedDepth}copy(e,t){return super.copy(e,t),this.matrixWorldInverse.copy(e.matrixWorldInverse),this.projectionMatrix.copy(e.projectionMatrix),this.projectionMatrixInverse.copy(e.projectionMatrixInverse),this.coordinateSystem=e.coordinateSystem,this}getWorldDirection(e){return super.getWorldDirection(e).negate()}updateMatrixWorld(e){super.updateMatrixWorld(e),this.matrixWorld.decompose(gh,vh,Zi),Zi.x===1&&Zi.y===1&&Zi.z===1?this.matrixWorldInverse.copy(this.matrixWorld).invert():this.matrixWorldInverse.compose(gh,vh,Zi.set(1,1,1)).invert()}updateWorldMatrix(e,t,n=!1){super.updateWorldMatrix(e,t,n),this.matrixWorld.decompose(gh,vh,Zi),Zi.x===1&&Zi.y===1&&Zi.z===1?this.matrixWorldInverse.copy(this.matrixWorld).invert():this.matrixWorldInverse.compose(gh,vh,Zi.set(1,1,1)).invert()}clone(){return new this.constructor().copy(this)}},Hr=new R,gg=new he,vg=new he,Ft=class extends Hs{constructor(e=50,t=1,n=.1,r=2e3){super(),this.isPerspectiveCamera=!0,this.type="PerspectiveCamera",this.fov=e,this.zoom=1,this.near=n,this.far=r,this.focus=10,this.aspect=t,this.view=null,this.filmGauge=35,this.filmOffset=0,this.updateProjectionMatrix()}copy(e,t){return super.copy(e,t),this.fov=e.fov,this.zoom=e.zoom,this.near=e.near,this.far=e.far,this.focus=e.focus,this.aspect=e.aspect,this.view=e.view===null?null:Object.assign({},e.view),this.filmGauge=e.filmGauge,this.filmOffset=e.filmOffset,this}setFocalLength(e){let t=.5*this.getFilmHeight()/e;this.fov=Ts*2*Math.atan(t),this.updateProjectionMatrix()}getFocalLength(){let e=Math.tan(bs*.5*this.fov);return .5*this.getFilmHeight()/e}getEffectiveFOV(){return Ts*2*Math.atan(Math.tan(bs*.5*this.fov)/this.zoom)}getFilmWidth(){return this.filmGauge*Math.min(this.aspect,1)}getFilmHeight(){return this.filmGauge/Math.max(this.aspect,1)}getViewBounds(e,t,n){Hr.set(-1,-1,.5).applyMatrix4(this.projectionMatrixInverse),t.set(Hr.x,Hr.y).multiplyScalar(-e/Hr.z),Hr.set(1,1,.5).applyMatrix4(this.projectionMatrixInverse),n.set(Hr.x,Hr.y).multiplyScalar(-e/Hr.z)}getViewSize(e,t){return this.getViewBounds(e,gg,vg),t.subVectors(vg,gg)}setViewOffset(e,t,n,r,s,o){this.aspect=e/t,this.view===null&&(this.view={enabled:!0,fullWidth:1,fullHeight:1,offsetX:0,offsetY:0,width:1,height:1}),this.view.enabled=!0,this.view.fullWidth=e,this.view.fullHeight=t,this.view.offsetX=n,this.view.offsetY=r,this.view.width=s,this.view.height=o,this.updateProjectionMatrix()}clearViewOffset(){this.view!==null&&(this.view.enabled=!1),this.updateProjectionMatrix()}updateProjectionMatrix(){let e=this.near,t=e*Math.tan(bs*.5*this.fov)/this.zoom,n=2*t,r=this.aspect*n,s=-.5*r,o=this.view;if(this.view!==null&&this.view.enabled){let l=o.fullWidth,c=o.fullHeight;s+=o.offsetX*r/l,t-=o.offsetY*n/c,r*=o.width/l,n*=o.height/c}let a=this.filmOffset;a!==0&&(s+=e*a/this.getFilmWidth()),this.projectionMatrix.makePerspective(s,s+r,t,t-n,e,this.far,this.coordinateSystem,this.reversedDepth),this.projectionMatrixInverse.copy(this.projectionMatrix).invert()}toJSON(e){let t=super.toJSON(e);return t.object.fov=this.fov,t.object.zoom=this.zoom,t.object.near=this.near,t.object.far=this.far,t.object.focus=this.focus,t.object.aspect=this.aspect,this.view!==null&&(t.object.view=Object.assign({},this.view)),t.object.filmGauge=this.filmGauge,t.object.filmOffset=this.filmOffset,t}},Sp=class extends Vs{constructor(){super(new Ft(50,1,.5,500)),this.isSpotLightShadow=!0,this.focus=1,this.aspect=1}updateMatrices(e){let t=this.camera,n=Ts*2*e.angle*this.focus,r=this.mapSize.width/this.mapSize.height*this.aspect,s=e.distance||t.far;(n!==t.fov||r!==t.aspect||s!==t.far)&&(t.fov=n,t.aspect=r,t.far=s,t.updateProjectionMatrix()),super.updateMatrices(e)}copy(e){return super.copy(e),this.focus=e.focus,this.aspect=e.aspect,this}toJSON(){let e=super.toJSON();return e.focus=this.focus,e.aspect=this.aspect,e}},cc=class extends Oi{constructor(e,t,n=0,r=Math.PI/3,s=0,o=2){super(e,t),this.isSpotLight=!0,this.type="SpotLight",this.position.copy(At.DEFAULT_UP),this.updateMatrix(),this.target=new At,this.distance=n,this.angle=r,this.penumbra=s,this.decay=o,this.map=null,this.shadow=new Sp}get power(){return this.intensity*Math.PI}set power(e){this.intensity=e/Math.PI}dispose(){super.dispose(),this.shadow.dispose()}copy(e,t){return super.copy(e,t),this.distance=e.distance,this.angle=e.angle,this.penumbra=e.penumbra,this.decay=e.decay,this.target=e.target.clone(),this.map=e.map,this.shadow=e.shadow.clone(),this}toJSON(e){let t=super.toJSON(e);return t.object.distance=this.distance,t.object.angle=this.angle,t.object.decay=this.decay,t.object.penumbra=this.penumbra,t.object.target=this.target.uuid,this.map&&this.map.isTexture&&(t.object.map=this.map.toJSON(e).uuid),t.object.shadow=this.shadow.toJSON(),t}},bp=class extends Vs{constructor(){super(new Ft(90,1,.5,500)),this.isPointLightShadow=!0}},Ar=class extends Oi{constructor(e,t,n=0,r=2){super(e,t),this.isPointLight=!0,this.type="PointLight",this.distance=n,this.decay=r,this.shadow=new bp}get power(){return this.intensity*4*Math.PI}set power(e){this.intensity=e/(4*Math.PI)}dispose(){super.dispose(),this.shadow.dispose()}copy(e,t){return super.copy(e,t),this.distance=e.distance,this.decay=e.decay,this.shadow=e.shadow.clone(),this}toJSON(e){let t=super.toJSON(e);return t.object.distance=this.distance,t.object.decay=this.decay,t.object.shadow=this.shadow.toJSON(),t}},tr=class extends Hs{constructor(e=-1,t=1,n=1,r=-1,s=.1,o=2e3){super(),this.isOrthographicCamera=!0,this.type="OrthographicCamera",this.zoom=1,this.view=null,this.left=e,this.right=t,this.top=n,this.bottom=r,this.near=s,this.far=o,this.updateProjectionMatrix()}copy(e,t){return super.copy(e,t),this.left=e.left,this.right=e.right,this.top=e.top,this.bottom=e.bottom,this.near=e.near,this.far=e.far,this.zoom=e.zoom,this.view=e.view===null?null:Object.assign({},e.view),this}setViewOffset(e,t,n,r,s,o){this.view===null&&(this.view={enabled:!0,fullWidth:1,fullHeight:1,offsetX:0,offsetY:0,width:1,height:1}),this.view.enabled=!0,this.view.fullWidth=e,this.view.fullHeight=t,this.view.offsetX=n,this.view.offsetY=r,this.view.width=s,this.view.height=o,this.updateProjectionMatrix()}clearViewOffset(){this.view!==null&&(this.view.enabled=!1),this.updateProjectionMatrix()}updateProjectionMatrix(){let e=(this.right-this.left)/(2*this.zoom),t=(this.top-this.bottom)/(2*this.zoom),n=(this.right+this.left)/2,r=(this.top+this.bottom)/2,s=n-e,o=n+e,a=r+t,l=r-t;if(this.view!==null&&this.view.enabled){let c=(this.right-this.left)/this.view.fullWidth/this.zoom,u=(this.top-this.bottom)/this.view.fullHeight/this.zoom;s+=c*this.view.offsetX,o=s+c*this.view.width,a-=u*this.view.offsetY,l=a-u*this.view.height}this.projectionMatrix.makeOrthographic(s,o,a,l,this.near,this.far,this.coordinateSystem,this.reversedDepth),this.projectionMatrixInverse.copy(this.projectionMatrix).invert()}toJSON(e){let t=super.toJSON(e);return t.object.zoom=this.zoom,t.object.left=this.left,t.object.right=this.right,t.object.top=this.top,t.object.bottom=this.bottom,t.object.near=this.near,t.object.far=this.far,this.view!==null&&(t.object.view=Object.assign({},this.view)),t}},wp=class extends Vs{constructor(){super(new tr(-5,5,5,-5,.5,500)),this.isDirectionalLightShadow=!0}},Ws=class extends Oi{constructor(e,t){super(e,t),this.isDirectionalLight=!0,this.type="DirectionalLight",this.position.copy(At.DEFAULT_UP),this.updateMatrix(),this.target=new At,this.shadow=new wp}dispose(){super.dispose(),this.shadow.dispose()}copy(e){return super.copy(e),this.target=e.target.clone(),this.shadow=e.shadow.clone(),this}toJSON(e){let t=super.toJSON(e);return t.object.shadow=this.shadow.toJSON(),t.object.target=this.target.uuid,t}},uc=class extends Oi{constructor(e,t){super(e,t),this.isAmbientLight=!0,this.type="AmbientLight"}},hc=class extends Oi{constructor(e,t,n=10,r=10){super(e,t),this.isRectAreaLight=!0,this.type="RectAreaLight",this.width=n,this.height=r}get power(){return this.intensity*this.width*this.height*Math.PI}set power(e){this.intensity=e/(this.width*this.height*Math.PI)}copy(e){return super.copy(e),this.width=e.width,this.height=e.height,this}toJSON(e){let t=super.toJSON(e);return t.object.width=this.width,t.object.height=this.height,t}},ca=class{constructor(){this.isSphericalHarmonics3=!0,this.coefficients=[];for(let e=0;e<9;e++)this.coefficients.push(new R)}set(e){for(let t=0;t<9;t++)this.coefficients[t].copy(e[t]);return this}zero(){for(let e=0;e<9;e++)this.coefficients[e].set(0,0,0);return this}getAt(e,t){let n=e.x,r=e.y,s=e.z,o=this.coefficients;return t.copy(o[0]).multiplyScalar(.282095),t.addScaledVector(o[1],.488603*r),t.addScaledVector(o[2],.488603*s),t.addScaledVector(o[3],.488603*n),t.addScaledVector(o[4],1.092548*(n*r)),t.addScaledVector(o[5],1.092548*(r*s)),t.addScaledVector(o[6],.315392*(3*s*s-1)),t.addScaledVector(o[7],1.092548*(n*s)),t.addScaledVector(o[8],.546274*(n*n-r*r)),t}getIrradianceAt(e,t){let n=e.x,r=e.y,s=e.z,o=this.coefficients;return t.copy(o[0]).multiplyScalar(.886227),t.addScaledVector(o[1],2*.511664*r),t.addScaledVector(o[2],2*.511664*s),t.addScaledVector(o[3],2*.511664*n),t.addScaledVector(o[4],2*.429043*n*r),t.addScaledVector(o[5],2*.429043*r*s),t.addScaledVector(o[6],.743125*s*s-.247708),t.addScaledVector(o[7],2*.429043*n*s),t.addScaledVector(o[8],.429043*(n*n-r*r)),t}add(e){for(let t=0;t<9;t++)this.coefficients[t].add(e.coefficients[t]);return this}addScaledSH(e,t){for(let n=0;n<9;n++)this.coefficients[n].addScaledVector(e.coefficients[n],t);return this}scale(e){for(let t=0;t<9;t++)this.coefficients[t].multiplyScalar(e);return this}lerp(e,t){for(let n=0;n<9;n++)this.coefficients[n].lerp(e.coefficients[n],t);return this}equals(e){for(let t=0;t<9;t++)if(!this.coefficients[t].equals(e.coefficients[t]))return!1;return!0}copy(e){return this.set(e.coefficients)}clone(){return new this.constructor().copy(this)}fromArray(e,t=0){let n=this.coefficients;for(let r=0;r<9;r++)n[r].fromArray(e,t+r*3);return this}toArray(e=[],t=0){let n=this.coefficients;for(let r=0;r<9;r++)n[r].toArray(e,t+r*3);return e}static getBasisAt(e,t){let n=e.x,r=e.y,s=e.z;t[0]=.282095,t[1]=.488603*r,t[2]=.488603*s,t[3]=.488603*n,t[4]=1.092548*n*r,t[5]=1.092548*r*s,t[6]=.315392*(3*s*s-1),t[7]=1.092548*n*s,t[8]=.546274*(n*n-r*r)}},fc=class extends Oi{constructor(e=new ca,t=1){super(void 0,t),this.isLightProbe=!0,this.sh=e}copy(e){return super.copy(e),this.sh.copy(e.sh),this}toJSON(e){let t=super.toJSON(e);return t.object.sh=this.sh.toArray(),t}},xg={},dc=class i extends _n{constructor(e){super(e),this.textures={}}load(e,t,n,r){let s=this,o=new Ai(s.manager);o.setPath(s.path),o.setRequestHeader(s.requestHeader),o.setWithCredentials(s.withCredentials),o.load(e,function(a){try{t(s.parse(JSON.parse(a)))}catch(l){r?r(l):Qe(l),s.manager.itemError(e)}},n,r)}parse(e){let t=this.createMaterialFromType(e.type);return t.fromJSON(e,this.textures),t}setTextures(e){return this.textures=e,this}createMaterialFromType(e){return i.createMaterialFromType(e)}static createMaterialFromType(e){let n={ShadowMaterial:Kl,SpriteMaterial:Xo,RawShaderMaterial:Qr,ShaderMaterial:Lt,PointsMaterial:Yo,MeshPhysicalMaterial:jl,MeshStandardMaterial:Dt,MeshPhongMaterial:Ql,MeshToonMaterial:ec,MeshNormalMaterial:tc,MeshLambertMaterial:nc,MeshDepthMaterial:ia,MeshDistanceMaterial:ra,MeshBasicMaterial:Hn,MeshMatcapMaterial:ic,LineDashedMaterial:rc,LineBasicMaterial:dn,Material:an,...xg}[e],r;return n===void 0?($i(`MaterialLoader: Unknown material type "${e}". Use .registerMaterial() before starting the deserialization process.`),r=new an):r=new n,r}static registerMaterial(e,t){xg[e]=t}},ua=class{static extractUrlBase(e){let t=e.lastIndexOf("/");return t===-1?"./":e.slice(0,t+1)}static resolveURL(e,t){return typeof e!="string"||e===""?"":(/^https?:\/\//i.test(t)&&/^\//.test(e)&&(t=t.replace(/(^https?:\/\/[^\/]+).*/i,"$1")),/^(https?:)?\/\//i.test(e)||/^data:.*,.*$/i.test(e)||/^blob:.*$/i.test(e)?e:t+e)}},pc=class extends et{constructor(){super(),this.isInstancedBufferGeometry=!0,this.type="InstancedBufferGeometry",this.instanceCount=1/0}copy(e){return super.copy(e),this.instanceCount=e.instanceCount,this}toJSON(){let e=super.toJSON();return e.instanceCount=this.instanceCount,e.isInstancedBufferGeometry=!0,e}},mc=class extends _n{constructor(e){super(e)}load(e,t,n,r){let s=this,o=new Ai(s.manager);o.setPath(s.path),o.setRequestHeader(s.requestHeader),o.setWithCredentials(s.withCredentials),o.load(e,function(a){try{t(s.parse(JSON.parse(a)))}catch(l){r?r(l):Qe(l),s.manager.itemError(e)}},n,r)}parse(e){let t={},n={};function r(d,p){if(t[p]!==void 0)return t[p];let g=d.interleavedBuffers[p],m=s(d,g.buffer),y=Do(g.type,m),_=new Jr(y,g.stride);return _.uuid=g.uuid,g.usage!==void 0&&_.setUsage(g.usage),t[p]=_,_}function s(d,p){if(n[p]!==void 0)return n[p];let g=d.arrayBuffers[p],m=new Uint32Array(g).buffer;return n[p]=m,m}let o=e.isInstancedBufferGeometry?new pc:new et,a=e.data.index;if(a!==void 0){let d=Do(a.type,a.array);o.setIndex(new ht(d,1))}let l=e.data.attributes;for(let d in l){let p=l[d],v;if(p.isInterleavedBufferAttribute){let g=r(e.data,p.data);v=new _r(g,p.itemSize,p.offset,p.normalized)}else{let g=Do(p.type,p.array),m=p.isInstancedBufferAttribute?wi:ht;v=new m(g,p.itemSize,p.normalized)}p.name!==void 0&&(v.name=p.name),p.usage!==void 0&&v.setUsage(p.usage),p.gpuType!==void 0&&(v.gpuType=p.gpuType),o.setAttribute(d,v)}let c=e.data.morphAttributes;if(c)for(let d in c){let p=c[d],v=[];for(let g=0,m=p.length;g<m;g++){let y=p[g],_;if(y.isInterleavedBufferAttribute){let x=r(e.data,y.data);_=new _r(x,y.itemSize,y.offset,y.normalized)}else{let x=Do(y.type,y.array);_=new ht(x,y.itemSize,y.normalized)}y.name!==void 0&&(_.name=y.name),y.usage!==void 0&&_.setUsage(y.usage),y.gpuType!==void 0&&(_.gpuType=y.gpuType),v.push(_)}o.morphAttributes[d]=v}e.data.morphTargetsRelative&&(o.morphTargetsRelative=!0);let f=e.data.groups||e.data.drawcalls||e.data.offsets;if(f!==void 0)for(let d=0,p=f.length;d!==p;++d){let v=f[d];o.addGroup(v.start,v.count,v.materialIndex)}let h=e.data.boundingSphere;return h!==void 0&&(o.boundingSphere=new on().fromJSON(h)),e.name&&(o.name=e.name),e.userData&&(o.userData=e.userData),o}},cp={},Kh=class extends _n{constructor(e){super(e)}load(e,t,n,r){let s=this,o=this.path===""?ua.extractUrlBase(e):this.path;this.resourcePath=this.resourcePath||o;let a=new Ai(this.manager);a.setPath(this.path),a.setRequestHeader(this.requestHeader),a.setWithCredentials(this.withCredentials),a.load(e,function(l){let c=null;try{c=JSON.parse(l)}catch(f){r!==void 0&&r(f),Qe("ObjectLoader: Can't parse "+e+".",f.message);return}let u=c.metadata;if(u===void 0||u.type===void 0||u.type.toLowerCase()==="geometry"){r!==void 0&&r(new Error("THREE.ObjectLoader: Can't load "+e)),Qe("ObjectLoader: Can't load "+e);return}s.parse(c,t)},n,r)}async loadAsync(e,t){let n=this,r=this.path===""?ua.extractUrlBase(e):this.path;this.resourcePath=this.resourcePath||r;let s=new Ai(this.manager);s.setPath(this.path),s.setRequestHeader(this.requestHeader),s.setWithCredentials(this.withCredentials);let o=await s.loadAsync(e,t),a;try{a=JSON.parse(o)}catch(c){throw new Error("THREE.ObjectLoader: Can't parse "+e+". "+c.message)}let l=a.metadata;if(l===void 0||l.type===void 0||l.type.toLowerCase()==="geometry")throw new Error("THREE.ObjectLoader: Can't load "+e);return await n.parseAsync(a)}parse(e,t){let n=this.parseAnimations(e.animations),r=this.parseShapes(e.shapes),s=this.parseGeometries(e.geometries,r),o=this.parseImages(e.images,function(){t!==void 0&&t(c)}),a=this.parseTextures(e.textures,o),l=this.parseMaterials(e.materials,a),c=this.parseObject(e.object,s,l,a,n),u=this.parseSkeletons(e.skeletons,c);if(this.bindSkeletons(c,u),this.bindLightTargets(c),t!==void 0){let f=!1;for(let h in o)if(o[h].data instanceof HTMLImageElement){f=!0;break}f===!1&&t(c)}return c}async parseAsync(e){let t=this.parseAnimations(e.animations),n=this.parseShapes(e.shapes),r=this.parseGeometries(e.geometries,n),s=await this.parseImagesAsync(e.images),o=this.parseTextures(e.textures,s),a=this.parseMaterials(e.materials,o),l=this.parseObject(e.object,r,a,o,t),c=this.parseSkeletons(e.skeletons,l);return this.bindSkeletons(l,c),this.bindLightTargets(l),l}static registerGeometry(e,t){cp[e]=t}parseShapes(e){let t={};if(e!==void 0)for(let n=0,r=e.length;n<r;n++){let s=new Ti().fromJSON(e[n]);t[s.uuid]=s}return t}parseSkeletons(e,t){let n={},r={};if(t.traverse(function(s){s.isBone&&(r[s.uuid]=s)}),e!==void 0)for(let s=0,o=e.length;s<o;s++){let a=new Cl().fromJSON(e[s],r);n[a.uuid]=a}return n}parseGeometries(e,t){let n={};if(e!==void 0){let r=new mc;for(let s=0,o=e.length;s<o;s++){let a,l=e[s];switch(l.type){case"BufferGeometry":case"InstancedBufferGeometry":a=r.parse(l);break;default:l.type in ug?a=ug[l.type].fromJSON(l,t):l.type in cp?a=cp[l.type].fromJSON(l,t):Ge(`ObjectLoader: Unknown geometry type "${l.type}". Use .registerGeometry() before starting the deserialization process.`)}a.uuid=l.uuid,l.name!==void 0&&(a.name=l.name),l.userData!==void 0&&(a.userData=l.userData),n[l.uuid]=a}}return n}parseMaterials(e,t){let n={},r={};if(e!==void 0){let s=new dc;s.setTextures(t);for(let o=0,a=e.length;o<a;o++){let l=e[o];n[l.uuid]===void 0&&(n[l.uuid]=s.parse(l)),r[l.uuid]=n[l.uuid]}}return r}parseAnimations(e){let t={};if(e!==void 0)for(let n=0;n<e.length;n++){let r=e[n],s=es.parse(r);t[s.uuid]=s}return t}parseImages(e,t){let n=this,r={},s;function o(l){return l=n.manager.resolveURL(l),n.manager.itemStart(l),s.load(l,function(){n.manager.itemEnd(l)},void 0,function(){n.manager.itemError(l),n.manager.itemEnd(l)})}function a(l){if(typeof l=="string"){let c=l,u=/^(\/\/)|([a-z]+:(\/\/)?)/i.test(c)?c:n.resourcePath+c;return o(u)}else return l.data?{data:Do(l.type,l.data),width:l.width,height:l.height}:null}if(e!==void 0&&e.length>0){let l=new la(t);s=new ts(l),s.setCrossOrigin(this.crossOrigin);for(let c=0,u=e.length;c<u;c++){let f=e[c],h=f.url;if(Array.isArray(h)){let d=[];for(let p=0,v=h.length;p<v;p++){let g=h[p],m=a(g);m!==null&&(m instanceof HTMLImageElement?d.push(m):d.push(new Gn(m.data,m.width,m.height)))}r[f.uuid]=new Si(d)}else{let d=a(f.url);r[f.uuid]=new Si(d)}}}return r}async parseImagesAsync(e){let t=this,n={},r;async function s(o){if(typeof o=="string"){let a=o,l=/^(\/\/)|([a-z]+:(\/\/)?)/i.test(a)?a:t.resourcePath+a;return await r.loadAsync(l)}else return o.data?{data:Do(o.type,o.data),width:o.width,height:o.height}:null}if(e!==void 0&&e.length>0){r=new ts(this.manager),r.setCrossOrigin(this.crossOrigin);for(let o=0,a=e.length;o<a;o++){let l=e[o],c=l.url;if(Array.isArray(c)){let u=[];for(let f=0,h=c.length;f<h;f++){let d=c[f],p=await s(d);p!==null&&(p instanceof HTMLImageElement?u.push(p):u.push(new Gn(p.data,p.width,p.height)))}n[l.uuid]=new Si(u)}else{let u=await s(l.url);n[l.uuid]=new Si(u)}}}return n}parseTextures(e,t){function n(s,o){return typeof s=="number"?s:(Ge("ObjectLoader.parseTexture: Constant should be in numeric form.",s),o[s])}let r={};if(e!==void 0)for(let s=0,o=e.length;s<o;s++){let a=e[s];a.image===void 0&&Ge('ObjectLoader: No "image" specified for',a.uuid),t[a.image]===void 0&&Ge("ObjectLoader: Undefined image",a.image);let l=t[a.image],c=l.data,u;Array.isArray(c)?(u=new Kr,c.length===6&&(u.needsUpdate=!0)):(c&&c.data?u=new Gn:u=new jt,c&&(u.needsUpdate=!0)),u.source=l,u.uuid=a.uuid,a.name!==void 0&&(u.name=a.name),a.mapping!==void 0&&(u.mapping=n(a.mapping,l1)),a.channel!==void 0&&(u.channel=a.channel),a.offset!==void 0&&u.offset.fromArray(a.offset),a.repeat!==void 0&&u.repeat.fromArray(a.repeat),a.center!==void 0&&u.center.fromArray(a.center),a.rotation!==void 0&&(u.rotation=a.rotation),a.wrap!==void 0&&(u.wrapS=n(a.wrap[0],yg),u.wrapT=n(a.wrap[1],yg)),a.format!==void 0&&(u.format=a.format),a.internalFormat!==void 0&&(u.internalFormat=a.internalFormat),a.type!==void 0&&(u.type=a.type),a.colorSpace!==void 0&&(u.colorSpace=a.colorSpace),a.minFilter!==void 0&&(u.minFilter=n(a.minFilter,_g)),a.magFilter!==void 0&&(u.magFilter=n(a.magFilter,_g)),a.anisotropy!==void 0&&(u.anisotropy=a.anisotropy),a.flipY!==void 0&&(u.flipY=a.flipY),a.generateMipmaps!==void 0&&(u.generateMipmaps=a.generateMipmaps),a.premultiplyAlpha!==void 0&&(u.premultiplyAlpha=a.premultiplyAlpha),a.unpackAlignment!==void 0&&(u.unpackAlignment=a.unpackAlignment),a.compareFunction!==void 0&&(u.compareFunction=a.compareFunction),a.normalized!==void 0&&(u.normalized=a.normalized),a.userData!==void 0&&(u.userData=a.userData),r[a.uuid]=u}return r}parseObject(e,t,n,r,s){let o;function a(h){return t[h]===void 0&&Ge("ObjectLoader: Undefined geometry",h),t[h]}function l(h){if(h!==void 0){if(Array.isArray(h)){let d=[];for(let p=0,v=h.length;p<v;p++){let g=h[p];n[g]===void 0&&Ge("ObjectLoader: Undefined material",g),d.push(n[g])}return d}return n[h]===void 0&&Ge("ObjectLoader: Undefined material",h),n[h]}}function c(h){return r[h]===void 0&&Ge("ObjectLoader: Undefined texture",h),r[h]}let u,f;switch(e.type){case"Scene":o=new li,e.background!==void 0&&(Number.isInteger(e.background)?o.background=new be(e.background):o.background=c(e.background)),e.environment!==void 0&&(o.environment=c(e.environment)),e.fog!==void 0&&(e.fog.type==="Fog"?o.fog=new wl(e.fog.color,e.fog.near,e.fog.far):e.fog.type==="FogExp2"&&(o.fog=new Ps(e.fog.color,e.fog.density)),e.fog.name!==""&&(o.fog.name=e.fog.name)),e.backgroundBlurriness!==void 0&&(o.backgroundBlurriness=e.backgroundBlurriness),e.backgroundIntensity!==void 0&&(o.backgroundIntensity=e.backgroundIntensity),e.backgroundRotation!==void 0&&o.backgroundRotation.fromArray(e.backgroundRotation),e.environmentIntensity!==void 0&&(o.environmentIntensity=e.environmentIntensity),e.environmentRotation!==void 0&&o.environmentRotation.fromArray(e.environmentRotation);break;case"PerspectiveCamera":o=new Ft(e.fov,e.aspect,e.near,e.far),e.focus!==void 0&&(o.focus=e.focus),e.zoom!==void 0&&(o.zoom=e.zoom),e.filmGauge!==void 0&&(o.filmGauge=e.filmGauge),e.filmOffset!==void 0&&(o.filmOffset=e.filmOffset),e.view!==void 0&&(o.view=Object.assign({},e.view));break;case"OrthographicCamera":o=new tr(e.left,e.right,e.top,e.bottom,e.near,e.far),e.zoom!==void 0&&(o.zoom=e.zoom),e.view!==void 0&&(o.view=Object.assign({},e.view));break;case"AmbientLight":o=new uc(e.color,e.intensity);break;case"DirectionalLight":o=new Ws(e.color,e.intensity),o.target=e.target||"";break;case"PointLight":o=new Ar(e.color,e.intensity,e.distance,e.decay);break;case"RectAreaLight":o=new hc(e.color,e.intensity,e.width,e.height);break;case"SpotLight":o=new cc(e.color,e.intensity,e.distance,e.angle,e.penumbra,e.decay),o.target=e.target||"";break;case"HemisphereLight":o=new Gs(e.color,e.groundColor,e.intensity);break;case"LightProbe":let h=new ca().fromArray(e.sh);o=new fc(h,e.intensity);break;case"SkinnedMesh":u=a(e.geometry),f=l(e.material),o=new El(u,f),e.bindMode!==void 0&&(o.bindMode=e.bindMode),e.bindMatrix!==void 0&&o.bindMatrix.fromArray(e.bindMatrix),e.skeleton!==void 0&&(o.skeleton=e.skeleton);break;case"Mesh":u=a(e.geometry),f=l(e.material),o=new at(u,f);break;case"InstancedMesh":u=a(e.geometry),f=l(e.material);let d=e.count,p=e.instanceMatrix,v=e.instanceColor;o=new Ji(u,f,d),o.instanceMatrix=new wi(new Float32Array(p.array),16),v!==void 0&&(o.instanceColor=new wi(new Float32Array(v.array),v.itemSize));break;case"BatchedMesh":u=a(e.geometry),f=l(e.material),o=new Pl(e.maxInstanceCount,e.maxVertexCount,e.maxIndexCount,f),o.geometry=u,o.perObjectFrustumCulled=e.perObjectFrustumCulled,o.sortObjects=e.sortObjects,o._drawRanges=e.drawRanges,o._reservedRanges=e.reservedRanges,o._geometryInfo=e.geometryInfo.map(g=>{let m=null,y=null;return g.boundingBox!==void 0&&(m=new cn().fromJSON(g.boundingBox)),g.boundingSphere!==void 0&&(y=new on().fromJSON(g.boundingSphere)),{...g,boundingBox:m,boundingSphere:y}}),o._instanceInfo=e.instanceInfo,o._availableInstanceIds=e._availableInstanceIds,o._availableGeometryIds=e._availableGeometryIds,o._nextIndexStart=e.nextIndexStart,o._nextVertexStart=e.nextVertexStart,o._geometryCount=e.geometryCount,o._maxInstanceCount=e.maxInstanceCount,o._maxVertexCount=e.maxVertexCount,o._maxIndexCount=e.maxIndexCount,o._geometryInitialized=e.geometryInitialized,o._matricesTexture=c(e.matricesTexture.uuid),o._indirectTexture=c(e.indirectTexture.uuid),e.colorsTexture!==void 0&&(o._colorsTexture=c(e.colorsTexture.uuid)),e.boundingSphere!==void 0&&(o.boundingSphere=new on().fromJSON(e.boundingSphere)),e.boundingBox!==void 0&&(o.boundingBox=new cn().fromJSON(e.boundingBox));break;case"LOD":o=new Al;break;case"Line":o=new Bi(a(e.geometry),l(e.material));break;case"LineLoop":o=new Il(a(e.geometry),l(e.material));break;case"LineSegments":o=new ci(a(e.geometry),l(e.material));break;case"PointCloud":case"Points":o=new Is(a(e.geometry),l(e.material));break;case"Sprite":o=new Tl(l(e.material));break;case"Group":o=new kn;break;case"Bone":o=new qo;break;default:o=new At}if(o.uuid=e.uuid,e.name!==void 0&&(o.name=e.name),e.matrix!==void 0?(o.matrix.fromArray(e.matrix),e.matrixAutoUpdate!==void 0&&(o.matrixAutoUpdate=e.matrixAutoUpdate),o.matrixAutoUpdate&&o.matrix.decompose(o.position,o.quaternion,o.scale)):(e.position!==void 0&&o.position.fromArray(e.position),e.rotation!==void 0&&o.rotation.fromArray(e.rotation),e.quaternion!==void 0&&o.quaternion.fromArray(e.quaternion),e.scale!==void 0&&o.scale.fromArray(e.scale)),e.up!==void 0&&o.up.fromArray(e.up),e.pivot!==void 0&&(o.pivot=new R().fromArray(e.pivot)),e.morphTargetDictionary!==void 0&&(o.morphTargetDictionary=Object.assign({},e.morphTargetDictionary)),e.morphTargetInfluences!==void 0&&(o.morphTargetInfluences=e.morphTargetInfluences.slice()),e.castShadow!==void 0&&(o.castShadow=e.castShadow),e.receiveShadow!==void 0&&(o.receiveShadow=e.receiveShadow),e.shadow&&(e.shadow.intensity!==void 0&&(o.shadow.intensity=e.shadow.intensity),e.shadow.bias!==void 0&&(o.shadow.bias=e.shadow.bias),e.shadow.normalBias!==void 0&&(o.shadow.normalBias=e.shadow.normalBias),e.shadow.radius!==void 0&&(o.shadow.radius=e.shadow.radius),e.shadow.blurSamples!==void 0&&(o.shadow.blurSamples=e.shadow.blurSamples),e.shadow.focus!==void 0&&(o.shadow.focus=e.shadow.focus),e.shadow.aspect!==void 0&&(o.shadow.aspect=e.shadow.aspect),e.shadow.mapSize!==void 0&&o.shadow.mapSize.fromArray(e.shadow.mapSize),e.shadow.camera!==void 0&&(o.shadow.camera=this.parseObject(e.shadow.camera))),e.visible!==void 0&&(o.visible=e.visible),e.frustumCulled!==void 0&&(o.frustumCulled=e.frustumCulled),e.renderOrder!==void 0&&(o.renderOrder=e.renderOrder),e.static!==void 0&&(o.static=e.static),e.userData!==void 0&&(o.userData=e.userData),e.layers!==void 0&&(o.layers.mask=e.layers),e.children!==void 0){let h=e.children;for(let d=0;d<h.length;d++)o.add(this.parseObject(h[d],t,n,r,s))}if(e.animations!==void 0){let h=e.animations;for(let d=0;d<h.length;d++){let p=h[d];o.animations.push(s[p])}}if(e.type==="LOD"){e.autoUpdate!==void 0&&(o.autoUpdate=e.autoUpdate);let h=e.levels;for(let d=0;d<h.length;d++){let p=h[d],v=o.getObjectByProperty("uuid",p.object);v!==void 0&&o.addLevel(v,p.distance,p.hysteresis)}}return o}bindSkeletons(e,t){Object.keys(t).length!==0&&e.traverse(function(n){if(n.isSkinnedMesh===!0&&n.skeleton!==void 0){let r=t[n.skeleton];r===void 0?Ge("ObjectLoader: No skeleton found with UUID:",n.skeleton):n.bind(r,n.bindMatrix)}})}bindLightTargets(e){e.traverse(function(t){if(t.isDirectionalLight||t.isSpotLight){let n=t.target,r=e.getObjectByProperty("uuid",n);r!==void 0?t.target=r:t.target=new At}})}},l1={UVMapping:Sc,CubeReflectionMapping:zi,CubeRefractionMapping:Rr,EquirectangularReflectionMapping:ya,EquirectangularRefractionMapping:_a,CubeUVReflectionMapping:Zs},yg={RepeatWrapping:Yr,ClampToEdgeWrapping:zn,MirroredRepeatWrapping:Fo},_g={NearestFilter:Kt,NearestMipmapNearestFilter:kf,NearestMipmapLinearFilter:$s,LinearFilter:zt,LinearMipmapNearestFilter:Ma,LinearMipmapLinearFilter:ki},up=new WeakMap,jh=class extends _n{constructor(e){super(e),this.isImageBitmapLoader=!0,typeof createImageBitmap>"u"&&Ge("ImageBitmapLoader: createImageBitmap() not supported."),typeof fetch>"u"&&Ge("ImageBitmapLoader: fetch() not supported."),this.options={premultiplyAlpha:"none"},this._abortController=new AbortController}setOptions(e){return this.options=e,this}load(e,t,n,r){e===void 0&&(e=""),this.path!==void 0&&(e=this.path+e),e=this.manager.resolveURL(e);let s=this,o=Fi.get(`image-bitmap:${e}`);if(o!==void 0){if(s.manager.itemStart(e),o.then){o.then(c=>{up.has(o)===!0?(r&&r(up.get(o)),s.manager.itemError(e),s.manager.itemEnd(e)):(t&&t(c),s.manager.itemEnd(e))});return}setTimeout(function(){t&&t(o),s.manager.itemEnd(e)},0);return}let a={};a.credentials=this.crossOrigin==="anonymous"?"same-origin":"include",a.headers=this.requestHeader,a.signal=typeof AbortSignal.any=="function"?AbortSignal.any([this._abortController.signal,this.manager.abortController.signal]):this._abortController.signal;let l=fetch(e,a).then(function(c){return c.blob()}).then(function(c){return createImageBitmap(c,Object.assign({},s.options,{colorSpaceConversion:"none"}))}).then(function(c){return Fi.add(`image-bitmap:${e}`,c),t&&t(c),s.manager.itemEnd(e),c}).catch(function(c){r&&r(c),up.set(l,c),Fi.remove(`image-bitmap:${e}`),s.manager.itemError(e),s.manager.itemEnd(e)});Fi.add(`image-bitmap:${e}`,l),s.manager.itemStart(e)}abort(){return this._abortController.abort(),this._abortController=new AbortController,this}},xh,ha=class{static getContext(){return xh===void 0&&(xh=new(window.AudioContext||window.webkitAudioContext)),xh}static setContext(e){xh=e}},Qh=class extends _n{constructor(e){super(e)}load(e,t,n,r){let s=this,o=new Ai(this.manager);o.setResponseType("arraybuffer"),o.setPath(this.path),o.setRequestHeader(this.requestHeader),o.setWithCredentials(this.withCredentials),o.load(e,function(l){try{let c=l.slice(0),u=ha.getContext(),f=e+"#decode";s.manager.itemStart(f),u.decodeAudioData(c,function(h){t(h),s.manager.itemEnd(f)}).catch(function(h){a(h),s.manager.itemEnd(f)})}catch(c){a(c)}},n,r);function a(l){r?r(l):Qe(l),s.manager.itemError(e)}}},Mg=new it,Sg=new it,vs=new it,ef=class{constructor(){this.type="StereoCamera",this.aspect=1,this.eyeSep=.064,this.cameraL=new Ft,this.cameraL.layers.enable(1),this.cameraL.matrixAutoUpdate=!1,this.cameraR=new Ft,this.cameraR.layers.enable(2),this.cameraR.matrixAutoUpdate=!1,this._cache={focus:null,fov:null,aspect:null,near:null,far:null,zoom:null,eyeSep:null}}update(e){let t=this._cache;if(t.focus!==e.focus||t.fov!==e.fov||t.aspect!==e.aspect*this.aspect||t.near!==e.near||t.far!==e.far||t.zoom!==e.zoom||t.eyeSep!==this.eyeSep){t.focus=e.focus,t.fov=e.fov,t.aspect=e.aspect*this.aspect,t.near=e.near,t.far=e.far,t.zoom=e.zoom,t.eyeSep=this.eyeSep,vs.copy(e.projectionMatrix);let r=t.eyeSep/2,s=r*t.near/t.focus,o=t.near*Math.tan(bs*t.fov*.5)/t.zoom,a,l;Sg.elements[12]=-r,Mg.elements[12]=r,a=-o*t.aspect+s,l=o*t.aspect+s,vs.elements[0]=2*t.near/(l-a),vs.elements[8]=(l+a)/(l-a),this.cameraL.projectionMatrix.copy(vs),a=-o*t.aspect-s,l=o*t.aspect-s,vs.elements[0]=2*t.near/(l-a),vs.elements[8]=(l+a)/(l-a),this.cameraR.projectionMatrix.copy(vs)}this.cameraL.matrix.copy(e.matrixWorld).multiply(Sg),this.cameraL.matrixWorldNeedsUpdate=!0,this.cameraR.matrix.copy(e.matrixWorld).multiply(Mg),this.cameraR.matrixWorldNeedsUpdate=!0}},Ro=-90,Po=1,gc=class extends At{constructor(e,t,n){super(),this.type="CubeCamera",this.renderTarget=n,this.coordinateSystem=null,this.activeMipmapLevel=0;let r=new Ft(Ro,Po,e,t);r.layers=this.layers,this.add(r);let s=new Ft(Ro,Po,e,t);s.layers=this.layers,this.add(s);let o=new Ft(Ro,Po,e,t);o.layers=this.layers,this.add(o);let a=new Ft(Ro,Po,e,t);a.layers=this.layers,this.add(a);let l=new Ft(Ro,Po,e,t);l.layers=this.layers,this.add(l);let c=new Ft(Ro,Po,e,t);c.layers=this.layers,this.add(c)}updateCoordinateSystem(){let e=this.coordinateSystem,t=this.children.concat(),[n,r,s,o,a,l]=t;for(let c of t)this.remove(c);if(e===Kn)n.up.set(0,1,0),n.lookAt(1,0,0),r.up.set(0,1,0),r.lookAt(-1,0,0),s.up.set(0,0,-1),s.lookAt(0,1,0),o.up.set(0,0,1),o.lookAt(0,-1,0),a.up.set(0,1,0),a.lookAt(0,0,1),l.up.set(0,1,0),l.lookAt(0,0,-1);else if(e===Zr)n.up.set(0,-1,0),n.lookAt(-1,0,0),r.up.set(0,-1,0),r.lookAt(1,0,0),s.up.set(0,0,1),s.lookAt(0,1,0),o.up.set(0,0,-1),o.lookAt(0,-1,0),a.up.set(0,-1,0),a.lookAt(0,0,1),l.up.set(0,-1,0),l.lookAt(0,0,-1);else throw new Error("THREE.CubeCamera.updateCoordinateSystem(): Invalid coordinate system: "+e);for(let c of t)this.add(c),c.updateMatrixWorld()}update(e,t){this.parent===null&&this.updateMatrixWorld();let{renderTarget:n,activeMipmapLevel:r}=this;this.coordinateSystem!==e.coordinateSystem&&(this.coordinateSystem=e.coordinateSystem,this.updateCoordinateSystem());let[s,o,a,l,c,u]=this.children,f=e.getRenderTarget(),h=e.getActiveCubeFace(),d=e.getActiveMipmapLevel(),p=e.xr.enabled;e.xr.enabled=!1;let v=n.texture.generateMipmaps;n.texture.generateMipmaps=!1;let g=!1;e.isWebGLRenderer===!0?g=e.state.buffers.depth.getReversed():g=e.reversedDepthBuffer,e.setRenderTarget(n,0,r),g&&e.autoClear===!1&&e.clearDepth(),e.render(t,s),e.setRenderTarget(n,1,r),g&&e.autoClear===!1&&e.clearDepth(),e.render(t,o),e.setRenderTarget(n,2,r),g&&e.autoClear===!1&&e.clearDepth(),e.render(t,a),e.setRenderTarget(n,3,r),g&&e.autoClear===!1&&e.clearDepth(),e.render(t,l),e.setRenderTarget(n,4,r),g&&e.autoClear===!1&&e.clearDepth(),e.render(t,c),n.texture.generateMipmaps=v,e.setRenderTarget(n,5,r),g&&e.autoClear===!1&&e.clearDepth(),e.render(t,u),e.setRenderTarget(f,h,d),e.xr.enabled=p,n.texture.needsPMREMUpdate=!0}},vc=class extends Ft{constructor(e=[]){super(),this.isArrayCamera=!0,this.isMultiViewCamera=!1,this.cameras=e}},Xs=class{constructor(){this._previousTime=0,this._currentTime=0,this._startTime=performance.now(),this._delta=0,this._elapsed=0,this._timescale=1,this._document=null,this._pageVisibilityHandler=null}connect(e){this._document=e,e.hidden!==void 0&&(this._pageVisibilityHandler=c1.bind(this),e.addEventListener("visibilitychange",this._pageVisibilityHandler,!1))}disconnect(){this._pageVisibilityHandler!==null&&(this._document.removeEventListener("visibilitychange",this._pageVisibilityHandler),this._pageVisibilityHandler=null),this._document=null}getDelta(){return this._delta/1e3}getElapsed(){return this._elapsed/1e3}getTimescale(){return this._timescale}setTimescale(e){return this._timescale=e,this}reset(){return this._currentTime=performance.now()-this._startTime,this}dispose(){this.disconnect()}update(e){return this._pageVisibilityHandler!==null&&this._document.hidden===!0?this._delta=0:(this._previousTime=this._currentTime,this._currentTime=(e!==void 0?e:performance.now())-this._startTime,this._delta=(this._currentTime-this._previousTime)*this._timescale,this._elapsed+=this._delta),this}};function c1(){this._document.hidden===!1&&this.reset()}var xs=new R,hp=new Jt,u1=new R,ys=new R,_s=new R,tf=class extends At{constructor(){super(),this.type="AudioListener",this.context=ha.getContext(),this.gain=this.context.createGain(),this.gain.connect(this.context.destination),this.filter=null,this.timeDelta=0,this._timer=new Xs}getInput(){return this.gain}removeFilter(){return this.filter!==null&&(this.gain.disconnect(this.filter),this.filter.disconnect(this.context.destination),this.gain.connect(this.context.destination),this.filter=null),this}getFilter(){return this.filter}setFilter(e){return this.filter!==null?(this.gain.disconnect(this.filter),this.filter.disconnect(this.context.destination)):this.gain.disconnect(this.context.destination),this.filter=e,this.gain.connect(this.filter),this.filter.connect(this.context.destination),this}getMasterVolume(){return this.gain.gain.value}setMasterVolume(e){return this.gain.gain.setTargetAtTime(e,this.context.currentTime,.01),this}updateMatrixWorld(e){super.updateMatrixWorld(e),this._timer.update();let t=this.context.listener;if(this.timeDelta=this._timer.getDelta(),this.matrixWorld.decompose(xs,hp,u1),ys.set(0,0,-1).applyQuaternion(hp),_s.set(0,1,0).applyQuaternion(hp),t.positionX){let n=this.context.currentTime+this.timeDelta;t.positionX.linearRampToValueAtTime(xs.x,n),t.positionY.linearRampToValueAtTime(xs.y,n),t.positionZ.linearRampToValueAtTime(xs.z,n),t.forwardX.linearRampToValueAtTime(ys.x,n),t.forwardY.linearRampToValueAtTime(ys.y,n),t.forwardZ.linearRampToValueAtTime(ys.z,n),t.upX.linearRampToValueAtTime(_s.x,n),t.upY.linearRampToValueAtTime(_s.y,n),t.upZ.linearRampToValueAtTime(_s.z,n)}else t.setPosition(xs.x,xs.y,xs.z),t.setOrientation(ys.x,ys.y,ys.z,_s.x,_s.y,_s.z)}},xc=class extends At{constructor(e){super(),this.type="Audio",this.listener=e,this.context=e.context,this.gain=this.context.createGain(),this.gain.connect(e.getInput()),this.autoplay=!1,this.buffer=null,this.detune=0,this.loop=!1,this.loopStart=0,this.loopEnd=0,this.offset=0,this.duration=void 0,this.playbackRate=1,this.isPlaying=!1,this.hasPlaybackControl=!0,this.source=null,this.sourceType="empty",this._startedAt=0,this._progress=0,this._connected=!1,this.filters=[]}getOutput(){return this.gain}setNodeSource(e){return this.hasPlaybackControl=!1,this.sourceType="audioNode",this.source=e,this.connect(),this}setMediaElementSource(e){return this.hasPlaybackControl=!1,this.sourceType="mediaNode",this.source=this.context.createMediaElementSource(e),this.connect(),this}setMediaStreamSource(e){return this.hasPlaybackControl=!1,this.sourceType="mediaStreamNode",this.source=this.context.createMediaStreamSource(e),this.connect(),this}setBuffer(e){return this.buffer=e,this.sourceType="buffer",this.autoplay&&this.play(),this}play(e=0){if(this.isPlaying===!0){Ge("Audio: Audio is already playing.");return}if(this.hasPlaybackControl===!1){Ge("Audio: this Audio has no playback control.");return}this._startedAt=this.context.currentTime+e;let t=this.context.createBufferSource();return t.buffer=this.buffer,t.loop=this.loop,t.loopStart=this.loopStart,t.loopEnd=this.loopEnd,t.onended=this.onEnded.bind(this),t.start(this._startedAt,this._progress+this.offset,this.duration),this.isPlaying=!0,this.source=t,this.setDetune(this.detune),this.setPlaybackRate(this.playbackRate),this.connect()}pause(){if(this.hasPlaybackControl===!1){Ge("Audio: this Audio has no playback control.");return}return this.isPlaying===!0&&(this._progress+=Math.max(this.context.currentTime-this._startedAt,0)*this.playbackRate,this.loop===!0&&(this._progress=this._progress%(this.duration||this.buffer.duration)),this.source.stop(),this.source.onended=null,this.isPlaying=!1),this}stop(e=0){if(this.hasPlaybackControl===!1){Ge("Audio: this Audio has no playback control.");return}return this._progress=0,this.source!==null&&(this.source.stop(this.context.currentTime+e),this.source.onended=null),this.isPlaying=!1,this}connect(){if(this.filters.length>0){this.source.connect(this.filters[0]);for(let e=1,t=this.filters.length;e<t;e++)this.filters[e-1].connect(this.filters[e]);this.filters[this.filters.length-1].connect(this.getOutput())}else this.source.connect(this.getOutput());return this._connected=!0,this}disconnect(){if(this._connected!==!1){if(this.filters.length>0){this.source.disconnect(this.filters[0]);for(let e=1,t=this.filters.length;e<t;e++)this.filters[e-1].disconnect(this.filters[e]);this.filters[this.filters.length-1].disconnect(this.getOutput())}else this.source.disconnect(this.getOutput());return this._connected=!1,this}}getFilters(){return this.filters}setFilters(e){return e||(e=[]),this._connected===!0?(this.disconnect(),this.filters=e.slice(),this.connect()):this.filters=e.slice(),this}setDetune(e){return this.detune=e,this.isPlaying===!0&&this.source.detune!==void 0&&this.source.detune.setTargetAtTime(this.detune,this.context.currentTime,.01),this}getDetune(){return this.detune}getFilter(){return this.getFilters()[0]}setFilter(e){return this.setFilters(e?[e]:[])}setPlaybackRate(e){if(this.hasPlaybackControl===!1){Ge("Audio: this Audio has no playback control.");return}return this.playbackRate=e,this.isPlaying===!0&&this.source.playbackRate.setTargetAtTime(this.playbackRate,this.context.currentTime,.01),this}getPlaybackRate(){return this.playbackRate}onEnded(){this.isPlaying=!1,this._progress=0}getLoop(){return this.hasPlaybackControl===!1?(Ge("Audio: this Audio has no playback control."),!1):this.loop}setLoop(e){if(this.hasPlaybackControl===!1){Ge("Audio: this Audio has no playback control.");return}return this.loop=e,this.isPlaying===!0&&(this.source.loop=this.loop),this}setLoopStart(e){return this.loopStart=e,this}setLoopEnd(e){return this.loopEnd=e,this}getVolume(){return this.gain.gain.value}setVolume(e){return this.gain.gain.setTargetAtTime(e,this.context.currentTime,.01),this}copy(e,t){return super.copy(e,t),e.sourceType!=="buffer"?(Ge("Audio: Audio source type cannot be copied."),this):(this.autoplay=e.autoplay,this.buffer=e.buffer,this.detune=e.detune,this.loop=e.loop,this.loopStart=e.loopStart,this.loopEnd=e.loopEnd,this.offset=e.offset,this.duration=e.duration,this.playbackRate=e.playbackRate,this.hasPlaybackControl=e.hasPlaybackControl,this.sourceType=e.sourceType,this.filters=e.filters.slice(),this)}clone(e){return new this.constructor(this.listener).copy(this,e)}},Ms=new R,bg=new Jt,h1=new R,Ss=new R,nf=class extends xc{constructor(e){super(e),this.panner=this.context.createPanner(),this.panner.panningModel="HRTF",this.panner.connect(this.gain)}connect(){return super.connect(),this.panner.connect(this.gain),this}disconnect(){return super.disconnect(),this.panner.disconnect(this.gain),this}getOutput(){return this.panner}getRefDistance(){return this.panner.refDistance}setRefDistance(e){return this.panner.refDistance=e,this}getRolloffFactor(){return this.panner.rolloffFactor}setRolloffFactor(e){return this.panner.rolloffFactor=e,this}getDistanceModel(){return this.panner.distanceModel}setDistanceModel(e){return this.panner.distanceModel=e,this}getMaxDistance(){return this.panner.maxDistance}setMaxDistance(e){return this.panner.maxDistance=e,this}setDirectionalCone(e,t,n){return this.panner.coneInnerAngle=e,this.panner.coneOuterAngle=t,this.panner.coneOuterGain=n,this}updateMatrixWorld(e){if(super.updateMatrixWorld(e),this.hasPlaybackControl===!0&&this.isPlaying===!1)return;this.matrixWorld.decompose(Ms,bg,h1),Ss.set(0,0,1).applyQuaternion(bg);let t=this.panner;if(t.positionX){let n=this.context.currentTime+this.listener.timeDelta;t.positionX.linearRampToValueAtTime(Ms.x,n),t.positionY.linearRampToValueAtTime(Ms.y,n),t.positionZ.linearRampToValueAtTime(Ms.z,n),t.orientationX.linearRampToValueAtTime(Ss.x,n),t.orientationY.linearRampToValueAtTime(Ss.y,n),t.orientationZ.linearRampToValueAtTime(Ss.z,n)}else t.setPosition(Ms.x,Ms.y,Ms.z),t.setOrientation(Ss.x,Ss.y,Ss.z)}},rf=class{constructor(e,t=2048){this.analyser=e.context.createAnalyser(),this.analyser.fftSize=t,this.data=new Uint8Array(this.analyser.frequencyBinCount),e.getOutput().connect(this.analyser)}getFrequencyData(){return this.analyser.getByteFrequencyData(this.data),this.data}getAverageFrequency(){let e=0,t=this.getFrequencyData();for(let n=0;n<t.length;n++)e+=t[n];return e/t.length}},yc=class{constructor(e,t,n){this.binding=e,this.valueSize=n;let r,s,o;switch(t){case"quaternion":r=this._slerp,s=this._slerpAdditive,o=this._setAdditiveIdentityQuaternion,this.buffer=new Float64Array(n*6),this._workIndex=5;break;case"string":case"bool":r=this._select,s=this._select,o=this._setAdditiveIdentityOther,this.buffer=new Array(n*5);break;default:r=this._lerp,s=this._lerpAdditive,o=this._setAdditiveIdentityNumeric,this.buffer=new Float64Array(n*5)}this._mixBufferRegion=r,this._mixBufferRegionAdditive=s,this._setIdentity=o,this._origIndex=3,this._addIndex=4,this.cumulativeWeight=0,this.cumulativeWeightAdditive=0,this.useCount=0,this.referenceCount=0}accumulate(e,t){let n=this.buffer,r=this.valueSize,s=e*r+r,o=this.cumulativeWeight;if(o===0){for(let a=0;a!==r;++a)n[s+a]=n[a];o=t}else{o+=t;let a=t/o;this._mixBufferRegion(n,s,0,a,r)}this.cumulativeWeight=o}accumulateAdditive(e){let t=this.buffer,n=this.valueSize,r=n*this._addIndex;this.cumulativeWeightAdditive===0&&this._setIdentity(),this._mixBufferRegionAdditive(t,r,0,e,n),this.cumulativeWeightAdditive+=e}apply(e){let t=this.valueSize,n=this.buffer,r=e*t+t,s=this.cumulativeWeight,o=this.cumulativeWeightAdditive,a=this.binding;if(this.cumulativeWeight=0,this.cumulativeWeightAdditive=0,s<1){let l=t*this._origIndex;this._mixBufferRegion(n,r,l,1-s,t)}o>0&&this._mixBufferRegionAdditive(n,r,this._addIndex*t,1,t);for(let l=t,c=t+t;l!==c;++l)if(n[l]!==n[l+t]){a.setValue(n,r);break}}saveOriginalState(){let e=this.binding,t=this.buffer,n=this.valueSize,r=n*this._origIndex;e.getValue(t,r);for(let s=n,o=r;s!==o;++s)t[s]=t[r+s%n];this._setIdentity(),this.cumulativeWeight=0,this.cumulativeWeightAdditive=0}restoreOriginalState(){let e=this.valueSize*3;this.binding.setValue(this.buffer,e)}_setAdditiveIdentityNumeric(){let e=this._addIndex*this.valueSize,t=e+this.valueSize;for(let n=e;n<t;n++)this.buffer[n]=0}_setAdditiveIdentityQuaternion(){this._setAdditiveIdentityNumeric(),this.buffer[this._addIndex*this.valueSize+3]=1}_setAdditiveIdentityOther(){let e=this._origIndex*this.valueSize,t=this._addIndex*this.valueSize;for(let n=0;n<this.valueSize;n++)this.buffer[t+n]=this.buffer[e+n]}_select(e,t,n,r,s){if(r>=.5)for(let o=0;o!==s;++o)e[t+o]=e[n+o]}_slerp(e,t,n,r){Jt.slerpFlat(e,t,e,t,e,n,r)}_slerpAdditive(e,t,n,r,s){let o=this._workIndex*s;Jt.multiplyQuaternionsFlat(e,o,e,t,e,n),Jt.slerpFlat(e,t,e,t,e,o,r)}_lerp(e,t,n,r,s){let o=1-r;for(let a=0;a!==s;++a){let l=t+a;e[l]=e[l]*o+e[n+a]*r}}_lerpAdditive(e,t,n,r,s){for(let o=0;o!==s;++o){let a=t+o;e[a]=e[a]+e[n+o]*r}}},xm="\\[\\]\\.:\\/",f1=new RegExp("["+xm+"]","g"),ym="[^"+xm+"]",d1="[^"+xm.replace("\\.","")+"]",p1=/((?:WC+[\/:])*)/.source.replace("WC",ym),m1=/(WCOD+)?/.source.replace("WCOD",d1),g1=/(?:\.(WC+)(?:\[(.+)\])?)?/.source.replace("WC",ym),v1=/\.(WC+)(?:\[(.+)\])?/.source.replace("WC",ym),x1=new RegExp("^"+p1+m1+g1+v1+"$"),y1=["material","materials","bones","map"],Tp=class{constructor(e,t,n){let r=n||Rt.parseTrackName(t);this._targetGroup=e,this._bindings=e.subscribe_(t,r)}getValue(e,t){this.bind();let n=this._targetGroup.nCachedObjects_,r=this._bindings[n];r!==void 0&&r.getValue(e,t)}setValue(e,t){let n=this._bindings;for(let r=this._targetGroup.nCachedObjects_,s=n.length;r!==s;++r)n[r].setValue(e,t)}bind(){let e=this._bindings;for(let t=this._targetGroup.nCachedObjects_,n=e.length;t!==n;++t)e[t].bind()}unbind(){let e=this._bindings;for(let t=this._targetGroup.nCachedObjects_,n=e.length;t!==n;++t)e[t].unbind()}},Rt=class i{constructor(e,t,n){this.path=t,this.parsedPath=n||i.parseTrackName(t),this.node=i.findNode(e,this.parsedPath.nodeName),this.rootNode=e,this.getValue=this._getValue_unbound,this.setValue=this._setValue_unbound}static create(e,t,n){return e&&e.isAnimationObjectGroup?new i.Composite(e,t,n):new i(e,t,n)}static sanitizeNodeName(e){return e.replace(/\s/g,"_").replace(f1,"")}static parseTrackName(e){let t=x1.exec(e);if(t===null)throw new Error("THREE.PropertyBinding: Cannot parse trackName: "+e);let n={nodeName:t[2],objectName:t[3],objectIndex:t[4],propertyName:t[5],propertyIndex:t[6]},r=n.nodeName&&n.nodeName.lastIndexOf(".");if(r!==void 0&&r!==-1){let s=n.nodeName.substring(r+1);y1.indexOf(s)!==-1&&(n.nodeName=n.nodeName.substring(0,r),n.objectName=s)}if(n.propertyName===null||n.propertyName.length===0)throw new Error("THREE.PropertyBinding: can not parse propertyName from trackName: "+e);return n}static findNode(e,t){if(t===void 0||t===""||t==="."||t===-1||t===e.name||t===e.uuid)return e;if(e.skeleton){let n=e.skeleton.getBoneByName(t);if(n!==void 0)return n}if(e.children){let n=function(s){for(let o=0;o<s.length;o++){let a=s[o];if(a.name===t||a.uuid===t)return a;let l=n(a.children);if(l)return l}return null},r=n(e.children);if(r)return r}return null}_getValue_unavailable(){}_setValue_unavailable(){}_getValue_direct(e,t){e[t]=this.targetObject[this.propertyName]}_getValue_array(e,t){let n=this.resolvedProperty;for(let r=0,s=n.length;r!==s;++r)e[t++]=n[r]}_getValue_arrayElement(e,t){e[t]=this.resolvedProperty[this.propertyIndex]}_getValue_toArray(e,t){this.resolvedProperty.toArray(e,t)}_setValue_direct(e,t){this.targetObject[this.propertyName]=e[t]}_setValue_direct_setNeedsUpdate(e,t){this.targetObject[this.propertyName]=e[t],this.targetObject.needsUpdate=!0}_setValue_direct_setMatrixWorldNeedsUpdate(e,t){this.targetObject[this.propertyName]=e[t],this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_array(e,t){let n=this.resolvedProperty;for(let r=0,s=n.length;r!==s;++r)n[r]=e[t++]}_setValue_array_setNeedsUpdate(e,t){let n=this.resolvedProperty;for(let r=0,s=n.length;r!==s;++r)n[r]=e[t++];this.targetObject.needsUpdate=!0}_setValue_array_setMatrixWorldNeedsUpdate(e,t){let n=this.resolvedProperty;for(let r=0,s=n.length;r!==s;++r)n[r]=e[t++];this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_arrayElement(e,t){this.resolvedProperty[this.propertyIndex]=e[t]}_setValue_arrayElement_setNeedsUpdate(e,t){this.resolvedProperty[this.propertyIndex]=e[t],this.targetObject.needsUpdate=!0}_setValue_arrayElement_setMatrixWorldNeedsUpdate(e,t){this.resolvedProperty[this.propertyIndex]=e[t],this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_fromArray(e,t){this.resolvedProperty.fromArray(e,t)}_setValue_fromArray_setNeedsUpdate(e,t){this.resolvedProperty.fromArray(e,t),this.targetObject.needsUpdate=!0}_setValue_fromArray_setMatrixWorldNeedsUpdate(e,t){this.resolvedProperty.fromArray(e,t),this.targetObject.matrixWorldNeedsUpdate=!0}_getValue_unbound(e,t){this.bind(),this.getValue(e,t)}_setValue_unbound(e,t){this.bind(),this.setValue(e,t)}bind(){let e=this.node,t=this.parsedPath,n=t.objectName,r=t.propertyName,s=t.propertyIndex;if(e||(e=i.findNode(this.rootNode,t.nodeName),this.node=e),this.getValue=this._getValue_unavailable,this.setValue=this._setValue_unavailable,!e){Ge("PropertyBinding: No target node found for track: "+this.path+".");return}if(n){let c=t.objectIndex;switch(n){case"materials":if(!e.material){Qe("PropertyBinding: Can not bind to material as node does not have a material.",this);return}if(!e.material.materials){Qe("PropertyBinding: Can not bind to material.materials as node.material does not have a materials array.",this);return}e=e.material.materials;break;case"bones":if(!e.skeleton){Qe("PropertyBinding: Can not bind to bones as node does not have a skeleton.",this);return}e=e.skeleton.bones;for(let u=0;u<e.length;u++)if(e[u].name===c){c=u;break}break;case"map":if("map"in e){e=e.map;break}if(!e.material){Qe("PropertyBinding: Can not bind to material as node does not have a material.",this);return}if(!e.material.map){Qe("PropertyBinding: Can not bind to material.map as node.material does not have a map.",this);return}e=e.material.map;break;default:if(e[n]===void 0){Qe("PropertyBinding: Can not bind to objectName of node undefined.",this);return}e=e[n]}if(c!==void 0){if(e[c]===void 0){Qe("PropertyBinding: Trying to bind to objectIndex of objectName, but is undefined.",this,e);return}e=e[c]}}let o=e[r];if(o===void 0){let c=t.nodeName;Qe("PropertyBinding: Trying to update property for track: "+c+"."+r+" but it wasn't found.",e);return}let a=this.Versioning.None;this.targetObject=e,e.isMaterial===!0?a=this.Versioning.NeedsUpdate:e.isObject3D===!0&&(a=this.Versioning.MatrixWorldNeedsUpdate);let l=this.BindingType.Direct;if(s!==void 0){if(r==="morphTargetInfluences"){if(!e.geometry){Qe("PropertyBinding: Can not bind to morphTargetInfluences because node does not have a geometry.",this);return}if(!e.geometry.morphAttributes){Qe("PropertyBinding: Can not bind to morphTargetInfluences because node does not have a geometry.morphAttributes.",this);return}e.morphTargetDictionary[s]!==void 0&&(s=e.morphTargetDictionary[s])}l=this.BindingType.ArrayElement,this.resolvedProperty=o,this.propertyIndex=s}else o.fromArray!==void 0&&o.toArray!==void 0?(l=this.BindingType.HasFromToArray,this.resolvedProperty=o):Array.isArray(o)?(l=this.BindingType.EntireArray,this.resolvedProperty=o):this.propertyName=r;this.getValue=this.GetterByBindingType[l],this.setValue=this.SetterByBindingTypeAndVersioning[l][a]}unbind(){this.node=null,this.getValue=this._getValue_unbound,this.setValue=this._setValue_unbound}};Rt.Composite=Tp;Rt.prototype.BindingType={Direct:0,EntireArray:1,ArrayElement:2,HasFromToArray:3};Rt.prototype.Versioning={None:0,NeedsUpdate:1,MatrixWorldNeedsUpdate:2};Rt.prototype.GetterByBindingType=[Rt.prototype._getValue_direct,Rt.prototype._getValue_array,Rt.prototype._getValue_arrayElement,Rt.prototype._getValue_toArray];Rt.prototype.SetterByBindingTypeAndVersioning=[[Rt.prototype._setValue_direct,Rt.prototype._setValue_direct_setNeedsUpdate,Rt.prototype._setValue_direct_setMatrixWorldNeedsUpdate],[Rt.prototype._setValue_array,Rt.prototype._setValue_array_setNeedsUpdate,Rt.prototype._setValue_array_setMatrixWorldNeedsUpdate],[Rt.prototype._setValue_arrayElement,Rt.prototype._setValue_arrayElement_setNeedsUpdate,Rt.prototype._setValue_arrayElement_setMatrixWorldNeedsUpdate],[Rt.prototype._setValue_fromArray,Rt.prototype._setValue_fromArray_setNeedsUpdate,Rt.prototype._setValue_fromArray_setMatrixWorldNeedsUpdate]];var sf=class{constructor(){this.isAnimationObjectGroup=!0,this.uuid=ai(),this._objects=Array.prototype.slice.call(arguments),this.nCachedObjects_=0;let e={};this._indicesByUUID=e;for(let n=0,r=arguments.length;n!==r;++n)e[arguments[n].uuid]=n;this._paths=[],this._parsedPaths=[],this._bindings=[],this._bindingsIndicesByPath={};let t=this;this.stats={objects:{get total(){return t._objects.length},get inUse(){return this.total-t.nCachedObjects_}},get bindingsPerObject(){return t._bindings.length}}}add(){let e=this._objects,t=this._indicesByUUID,n=this._paths,r=this._parsedPaths,s=this._bindings,o=s.length,a,l=e.length,c=this.nCachedObjects_;for(let u=0,f=arguments.length;u!==f;++u){let h=arguments[u],d=h.uuid,p=t[d];if(p===void 0){p=l++,t[d]=p,e.push(h);for(let v=0,g=o;v!==g;++v)s[v].push(new Rt(h,n[v],r[v]))}else if(p<c){a=e[p];let v=--c,g=e[v];t[g.uuid]=p,e[p]=g,t[d]=v,e[v]=h;for(let m=0,y=o;m!==y;++m){let _=s[m],x=_[v],S=_[p];_[p]=x,S===void 0&&(S=new Rt(h,n[m],r[m])),_[v]=S}}else e[p]!==a&&Qe("AnimationObjectGroup: Different objects with the same UUID detected. Clean the caches or recreate your infrastructure when reloading scenes.")}this.nCachedObjects_=c}remove(){let e=this._objects,t=this._indicesByUUID,n=this._bindings,r=n.length,s=this.nCachedObjects_;for(let o=0,a=arguments.length;o!==a;++o){let l=arguments[o],c=l.uuid,u=t[c];if(u!==void 0&&u>=s){let f=s++,h=e[f];t[h.uuid]=u,e[u]=h,t[c]=f,e[f]=l;for(let d=0,p=r;d!==p;++d){let v=n[d],g=v[f],m=v[u];v[u]=g,v[f]=m}}}this.nCachedObjects_=s}uncache(){let e=this._objects,t=this._indicesByUUID,n=this._bindings,r=n.length,s=this.nCachedObjects_,o=e.length;for(let a=0,l=arguments.length;a!==l;++a){let c=arguments[a],u=c.uuid,f=t[u];if(f!==void 0)if(delete t[u],f<s){let h=--s,d=e[h],p=--o,v=e[p];f!==h&&(t[d.uuid]=f),e[f]=d,h!==p&&(t[v.uuid]=h),e[h]=v,e.pop();for(let g=0,m=r;g!==m;++g){let y=n[g],_=y[h],x=y[p];y[f]=_,y[h]=x,y.pop()}}else{let h=--o,d=e[h];f!==h&&(t[d.uuid]=f),e[f]=d,e.pop();for(let p=0,v=r;p!==v;++p){let g=n[p];g[f]=g[h],g.pop()}}}this.nCachedObjects_=s}subscribe_(e,t){let n=this._bindingsIndicesByPath,r=n[e],s=this._bindings;if(r!==void 0)return s[r];let o=this._paths,a=this._parsedPaths,l=this._objects,c=l.length,u=this.nCachedObjects_,f=new Array(c);r=s.length,n[e]=r,o.push(e),a.push(t),s.push(f);for(let h=u,d=l.length;h!==d;++h){let p=l[h];f[h]=new Rt(p,e,t)}return f}unsubscribe_(e){let t=this._bindingsIndicesByPath,n=t[e];if(n!==void 0){let r=this._paths,s=this._parsedPaths,o=this._bindings,a=o.length-1,l=o[a],c=r[a];t[c]=n,o[n]=l,o.pop(),s[n]=s[a],s.pop(),r[n]=r[a],r.pop()}}},_c=class{constructor(e,t,n=null,r=t.blendMode){this._mixer=e,this._clip=t,this._localRoot=n,this.blendMode=r;let s=t.tracks,o=s.length,a=new Array(o),l={endingStart:Xr,endingEnd:Xr};for(let c=0;c!==o;++c){let u=s[c].createInterpolant(null);a[c]=u,u.settings=l}this._interpolantSettings=l,this._interpolants=a,this._propertyBindings=new Array(o),this._cacheIndex=null,this._byClipCacheIndex=null,this._timeScaleInterpolant=null,this._restoreTimeScale=null,this._weightInterpolant=null,this.loop=Qp,this._loopCount=-1,this._startTime=null,this.time=0,this.timeScale=1,this._effectiveTimeScale=1,this.weight=1,this._effectiveWeight=1,this.repetitions=1/0,this.paused=!1,this.enabled=!0,this.clampWhenFinished=!1,this.zeroSlopeAtStart=!0,this.zeroSlopeAtEnd=!0}play(){return this._mixer._activateAction(this),this}stop(){return this._mixer._deactivateAction(this),this.reset()}reset(){return this.paused=!1,this.enabled=!0,this.time=0,this._loopCount=-1,this._startTime=null,this.stopFading().stopWarping()}isRunning(){return this.enabled&&!this.paused&&this.timeScale!==0&&this._startTime===null&&this._mixer._isActiveAction(this)}isScheduled(){return this._mixer._isActiveAction(this)}startAt(e){return this._startTime=e,this}setLoop(e,t){return this.loop=e,this.repetitions=t,this}setEffectiveWeight(e){return this.weight=e,this._effectiveWeight=this.enabled?e:0,this.stopFading()}getEffectiveWeight(){return this._effectiveWeight}fadeIn(e){return this._scheduleFading(e,0,1)}fadeOut(e){return this._scheduleFading(e,1,0)}crossFadeFrom(e,t,n=!1){if(e.fadeOut(t),this.fadeIn(t),n===!0){let r=this._clip.duration,s=e._clip.duration,o=s/r,a=r/s;e._restoreTimeScale=e.timeScale,this._restoreTimeScale=this.timeScale,e.warp(1,o,t),this.warp(a,1,t)}return this}crossFadeTo(e,t,n=!1){return e.crossFadeFrom(this,t,n)}stopFading(){let e=this._weightInterpolant;return e!==null&&(this._weightInterpolant=null,this._mixer._takeBackControlInterpolant(e)),this}setEffectiveTimeScale(e){return this.timeScale=e,this._effectiveTimeScale=this.paused?0:e,this.stopWarping()}getEffectiveTimeScale(){return this._effectiveTimeScale}setDuration(e){return this.timeScale=this._clip.duration/e,this.stopWarping()}syncWith(e){return this.time=e.time,this.timeScale=e.timeScale,this.stopWarping()}halt(e){return this.warp(this._effectiveTimeScale,0,e)}warp(e,t,n){let r=this._mixer,s=r.time,o=this.timeScale,a=this._timeScaleInterpolant;a===null&&(a=r._lendControlInterpolant(),this._timeScaleInterpolant=a);let l=a.parameterPositions,c=a.sampleValues;return l[0]=s,l[1]=s+n,c[0]=e/o,c[1]=t/o,this}stopWarping(){let e=this._timeScaleInterpolant;return e!==null&&(this._timeScaleInterpolant=null,this._mixer._takeBackControlInterpolant(e)),this._restoreTimeScale=null,this}getMixer(){return this._mixer}getClip(){return this._clip}getRoot(){return this._localRoot||this._mixer._root}_update(e,t,n,r){if(!this.enabled){this._updateWeight(e);return}let s=this._startTime;if(s!==null){let l=(e-s)*n;l<0||n===0?t=0:(this._startTime=null,t=n*l)}t*=this._updateTimeScale(e);let o=this._updateTime(t),a=this._updateWeight(e);if(a>0){let l=this._interpolants,c=this._propertyBindings;switch(this.blendMode){case Yf:for(let u=0,f=l.length;u!==f;++u)l[u].evaluate(o),c[u].accumulateAdditive(a);break;case su:default:for(let u=0,f=l.length;u!==f;++u)l[u].evaluate(o),c[u].accumulate(r,a)}}}_updateWeight(e){let t=0;if(this.enabled){t=this.weight;let n=this._weightInterpolant;if(n!==null){let r=n.evaluate(e)[0];t*=r,e>n.parameterPositions[1]&&(this.stopFading(),r===0&&(this.enabled=!1))}}return this._effectiveWeight=t,t}_updateTimeScale(e){let t=0;if(!this.paused){t=this.timeScale;let n=this._timeScaleInterpolant;if(n!==null){let r=n.evaluate(e)[0];t*=r,e>n.parameterPositions[1]&&(t===0?this.paused=!0:(this._restoreTimeScale!==null&&(t=this._restoreTimeScale),this.timeScale=t),this.stopWarping())}}return this._effectiveTimeScale=t,t}_updateTime(e){let t=this._clip.duration,n=this.loop,r=this.time+e,s=this._loopCount,o=n===em;if(e===0)return s===-1?r:o&&(s&1)===1?t-r:r;if(n===jp){s===-1&&(this._loopCount=0,this._setEndings(!0,!0,!1));e:{if(r>=t)r=t;else if(r<0)r=0;else{this.time=r;break e}this.clampWhenFinished?this.paused=!0:this.enabled=!1,this.time=r,this._mixer.dispatchEvent({type:"finished",action:this,direction:e<0?-1:1})}}else{if(s===-1&&(e>=0?(s=0,this._setEndings(!0,this.repetitions===0,o)):this._setEndings(this.repetitions===0,!0,o)),r>=t||r<0){let a=Math.floor(r/t);r-=t*a,s+=Math.abs(a);let l=this.repetitions-s;if(l<=0)this.clampWhenFinished?this.paused=!0:this.enabled=!1,r=e>0?t:0,this.time=r,this._mixer.dispatchEvent({type:"finished",action:this,direction:e>0?1:-1});else{if(l===1){let c=e<0;this._setEndings(c,!c,o)}else this._setEndings(!1,!1,o);this._loopCount=s,this.time=r,this._mixer.dispatchEvent({type:"loop",action:this,loopDelta:a})}}else this._loopCount=s,this.time=r;if(o&&(s&1)===1)return t-r}return r}_setEndings(e,t,n){let r=this._interpolantSettings;n?(r.endingStart=qr,r.endingEnd=qr):(e?r.endingStart=this.zeroSlopeAtStart?qr:Xr:r.endingStart=Bo,t?r.endingEnd=this.zeroSlopeAtEnd?qr:Xr:r.endingEnd=Bo)}_scheduleFading(e,t,n){let r=this._mixer,s=r.time,o=this._weightInterpolant;o===null&&(o=r._lendControlInterpolant(),this._weightInterpolant=o);let a=o.parameterPositions,l=o.sampleValues;return a[0]=s,l[0]=t,a[1]=s+e,l[1]=n,this}},_1=new Float32Array(1),of=class extends jn{constructor(e){super(),this._root=e,this._initMemoryManager(),this._accuIndex=0,this.time=0,this.timeScale=1,typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}_bindAction(e,t){let n=e._localRoot||this._root,r=e._clip.tracks,s=r.length,o=e._propertyBindings,a=e._interpolants,l=n.uuid,c=this._bindingsByRootAndName,u=c[l];u===void 0&&(u={},c[l]=u);for(let f=0;f!==s;++f){let h=r[f],d=h.name,p=u[d];if(p!==void 0)++p.referenceCount,o[f]=p;else{if(p=o[f],p!==void 0){p._cacheIndex===null&&(++p.referenceCount,this._addInactiveBinding(p,l,d));continue}let v=t&&t._propertyBindings[f].binding.parsedPath;p=new yc(Rt.create(n,d,v),h.ValueTypeName,h.getValueSize()),++p.referenceCount,this._addInactiveBinding(p,l,d),o[f]=p}a[f].resultBuffer=p.buffer}}_activateAction(e){if(!this._isActiveAction(e)){if(e._cacheIndex===null){let n=(e._localRoot||this._root).uuid,r=e._clip.uuid,s=this._actionsByClip[r];this._bindAction(e,s&&s.knownActions[0]),this._addInactiveAction(e,r,n)}let t=e._propertyBindings;for(let n=0,r=t.length;n!==r;++n){let s=t[n];s.useCount++===0&&(this._lendBinding(s),s.saveOriginalState())}this._lendAction(e)}}_deactivateAction(e){if(this._isActiveAction(e)){let t=e._propertyBindings;for(let n=0,r=t.length;n!==r;++n){let s=t[n];--s.useCount===0&&(s.restoreOriginalState(),this._takeBackBinding(s))}this._takeBackAction(e)}}_initMemoryManager(){this._actions=[],this._nActiveActions=0,this._actionsByClip={},this._bindings=[],this._nActiveBindings=0,this._bindingsByRootAndName={},this._controlInterpolants=[],this._nActiveControlInterpolants=0;let e=this;this.stats={actions:{get total(){return e._actions.length},get inUse(){return e._nActiveActions}},bindings:{get total(){return e._bindings.length},get inUse(){return e._nActiveBindings}},controlInterpolants:{get total(){return e._controlInterpolants.length},get inUse(){return e._nActiveControlInterpolants}}}}_isActiveAction(e){let t=e._cacheIndex;return t!==null&&t<this._nActiveActions}_addInactiveAction(e,t,n){let r=this._actions,s=this._actionsByClip,o=s[t];if(o===void 0)o={knownActions:[e],actionByRoot:{}},e._byClipCacheIndex=0,s[t]=o;else{let a=o.knownActions;e._byClipCacheIndex=a.length,a.push(e)}e._cacheIndex=r.length,r.push(e),o.actionByRoot[n]=e}_removeInactiveAction(e){let t=this._actions,n=t[t.length-1],r=e._cacheIndex;n._cacheIndex=r,t[r]=n,t.pop(),e._cacheIndex=null;let s=e._clip.uuid,o=this._actionsByClip,a=o[s],l=a.knownActions,c=l[l.length-1],u=e._byClipCacheIndex;c._byClipCacheIndex=u,l[u]=c,l.pop(),e._byClipCacheIndex=null;let f=a.actionByRoot,h=(e._localRoot||this._root).uuid;delete f[h],l.length===0&&delete o[s],this._removeInactiveBindingsForAction(e)}_removeInactiveBindingsForAction(e){let t=e._propertyBindings;for(let n=0,r=t.length;n!==r;++n){let s=t[n];--s.referenceCount===0&&this._removeInactiveBinding(s)}}_lendAction(e){let t=this._actions,n=e._cacheIndex,r=this._nActiveActions++,s=t[r];e._cacheIndex=r,t[r]=e,s._cacheIndex=n,t[n]=s}_takeBackAction(e){let t=this._actions,n=e._cacheIndex,r=--this._nActiveActions,s=t[r];e._cacheIndex=r,t[r]=e,s._cacheIndex=n,t[n]=s}_addInactiveBinding(e,t,n){let r=this._bindingsByRootAndName,s=this._bindings,o=r[t];o===void 0&&(o={},r[t]=o),o[n]=e,e._cacheIndex=s.length,s.push(e)}_removeInactiveBinding(e){let t=this._bindings,n=e.binding,r=n.rootNode.uuid,s=n.path,o=this._bindingsByRootAndName,a=o[r],l=t[t.length-1],c=e._cacheIndex;l._cacheIndex=c,t[c]=l,t.pop(),delete a[s],Object.keys(a).length===0&&delete o[r]}_lendBinding(e){let t=this._bindings,n=e._cacheIndex,r=this._nActiveBindings++,s=t[r];e._cacheIndex=r,t[r]=e,s._cacheIndex=n,t[n]=s}_takeBackBinding(e){let t=this._bindings,n=e._cacheIndex,r=--this._nActiveBindings,s=t[r];e._cacheIndex=r,t[r]=e,s._cacheIndex=n,t[n]=s}_lendControlInterpolant(){let e=this._controlInterpolants,t=this._nActiveControlInterpolants++,n=e[t];return n===void 0&&(n=new sa(new Float32Array(2),new Float32Array(2),1,_1),n.__cacheIndex=t,e[t]=n),n}_takeBackControlInterpolant(e){let t=this._controlInterpolants,n=e.__cacheIndex,r=--this._nActiveControlInterpolants,s=t[r];e.__cacheIndex=r,t[r]=e,s.__cacheIndex=n,t[n]=s}clipAction(e,t,n){let r=t||this._root,s=r.uuid,o=typeof e=="string"?es.findByName(r,e):e,a=o!==null?o.uuid:e,l=this._actionsByClip[a],c=null;if(n===void 0&&(o!==null?n=o.blendMode:n=su),l!==void 0){let f=l.actionByRoot[s];if(f!==void 0&&f.blendMode===n)return f;c=l.knownActions[0],o===null&&(o=c._clip)}if(o===null)return null;let u=new _c(this,o,t,n);return this._bindAction(u,c),this._addInactiveAction(u,a,s),u}existingAction(e,t){let n=t||this._root,r=n.uuid,s=typeof e=="string"?es.findByName(n,e):e,o=s?s.uuid:e,a=this._actionsByClip[o];return a!==void 0&&a.actionByRoot[r]||null}stopAllAction(){let e=this._actions,t=this._nActiveActions;for(let n=t-1;n>=0;--n)e[n].stop();return this}update(e){e*=this.timeScale;let t=this._actions,n=this._nActiveActions,r=this.time+=e,s=Math.sign(e),o=this._accuIndex^=1;for(let c=0;c!==n;++c)t[c]._update(r,e,s,o);let a=this._bindings,l=this._nActiveBindings;for(let c=0;c!==l;++c)a[c].apply(o);return this}setTime(e){this.time=0;for(let t=0;t<this._actions.length;t++)this._actions[t].time=0;return this.update(e)}getRoot(){return this._root}uncacheClip(e){let t=this._actions,n=e.uuid,r=this._actionsByClip,s=r[n];if(s!==void 0){let o=s.knownActions;for(let a=0,l=o.length;a!==l;++a){let c=o[a];this._deactivateAction(c);let u=c._cacheIndex,f=t[t.length-1];c._cacheIndex=null,c._byClipCacheIndex=null,f._cacheIndex=u,t[u]=f,t.pop(),this._removeInactiveBindingsForAction(c)}delete r[n]}}uncacheRoot(e){let t=e.uuid,n=this._actionsByClip;for(let o in n){let a=n[o].actionByRoot,l=a[t];l!==void 0&&(this._deactivateAction(l),this._removeInactiveAction(l))}let r=this._bindingsByRootAndName,s=r[t];if(s!==void 0)for(let o in s){let a=s[o];a.restoreOriginalState(),this._removeInactiveBinding(a)}}uncacheAction(e,t){let n=this.existingAction(e,t);n!==null&&(this._deactivateAction(n),this._removeInactiveAction(n))}},af=class extends Vo{constructor(e=1,t=1,n=1,r={}){super(e,t,r),this.isRenderTarget3D=!0,this.depth=n;for(let s=0;s<this.textures.length;s++){let o=new Es(null,e,t,n);o.isRenderTargetTexture=!0,o.renderTarget=this,this.textures[s]=o}this._setTextureOptions(r)}},lf=class i{constructor(e){this.value=e}clone(){return new i(this.value.clone===void 0?this.value:this.value.clone())}},M1=0,cf=class extends jn{constructor(){super(),this.isUniformsGroup=!0,Object.defineProperty(this,"id",{value:M1++}),this.name="",this.usage=js,this.uniforms=[]}add(e){return this.uniforms.push(e),this}remove(e){let t=this.uniforms.indexOf(e);return t!==-1&&this.uniforms.splice(t,1),this}setName(e){return this.name=e,this}setUsage(e){return this.usage=e,this}dispose(){this.dispatchEvent({type:"dispose"})}copy(e){this.name=e.name,this.usage=e.usage;let t=e.uniforms;this.uniforms.length=0;for(let n=0,r=t.length;n<r;n++){let s=Array.isArray(t[n])?t[n]:[t[n]];for(let o=0;o<s.length;o++)this.uniforms.push(s[o].clone())}return this}clone(){return new this.constructor().copy(this)}},uf=class extends Jr{constructor(e,t,n=1){super(e,t),this.isInstancedInterleavedBuffer=!0,this.meshPerAttribute=n}copy(e){return super.copy(e),this.meshPerAttribute=e.meshPerAttribute,this}clone(e){let t=super.clone(e);return t.meshPerAttribute=this.meshPerAttribute,t}toJSON(e){let t=super.toJSON(e);return t.isInstancedInterleavedBuffer=!0,t.meshPerAttribute=this.meshPerAttribute,t}},hf=class{constructor(e,t,n,r,s,o=!1){this.isGLBufferAttribute=!0,this.name="",this.buffer=e,this.type=t,this.itemSize=n,this.elementSize=r,this.count=s,this.normalized=o,this.version=0}set needsUpdate(e){e===!0&&this.version++}setBuffer(e){return this.buffer=e,this}setType(e,t){return this.type=e,this.elementSize=t,this}setItemSize(e){return this.itemSize=e,this}setCount(e){return this.count=e,this}},wg=new it,ff=class{constructor(e,t,n=0,r=1/0){this.ray=new Mr(e,t),this.near=n,this.far=r,this.camera=null,this.layers=new Cs,this.params={Mesh:{},Line:{threshold:1},LOD:{},Points:{threshold:1},Sprite:{}}}set(e,t){this.ray.set(e,t)}setFromCamera(e,t){t.isPerspectiveCamera?(this.ray.origin.setFromMatrixPosition(t.matrixWorld),this.ray.direction.set(e.x,e.y,.5).unproject(t).sub(this.ray.origin).normalize(),this.camera=t):t.isOrthographicCamera?(this.ray.origin.set(e.x,e.y,t.projectionMatrix.elements[14]).unproject(t),this.ray.direction.set(0,0,-1).transformDirection(t.matrixWorld),this.camera=t):Qe("Raycaster: Unsupported camera type: "+t.type)}setFromXRController(e){return wg.identity().extractRotation(e.matrixWorld),this.ray.origin.setFromMatrixPosition(e.matrixWorld),this.ray.direction.set(0,0,-1).applyMatrix4(wg),this}intersectObject(e,t=!0,n=[]){return Ap(e,this,n,t),n.sort(Tg),n}intersectObjects(e,t=!0,n=[]){for(let r=0,s=e.length;r<s;r++)Ap(e[r],this,n,t);return n.sort(Tg),n}};function Tg(i,e){return i.distance-e.distance}function Ap(i,e,t,n){let r=!0;if(i.layers.test(e.layers)&&i.raycast(e,t)===!1&&(r=!1),r===!0&&n===!0){let s=i.children;for(let o=0,a=s.length;o<a;o++)Ap(s[o],e,t,!0)}}var df=class{constructor(e=!0){this.autoStart=e,this.startTime=0,this.oldTime=0,this.elapsedTime=0,this.running=!1,Ge("Clock: This module has been deprecated. Please use THREE.Timer instead.")}start(){this.startTime=performance.now(),this.oldTime=this.startTime,this.elapsedTime=0,this.running=!0}stop(){this.getElapsedTime(),this.running=!1,this.autoStart=!1}getElapsedTime(){return this.getDelta(),this.elapsedTime}getDelta(){let e=0;if(this.autoStart&&!this.running)return this.start(),0;if(this.running){let t=performance.now();e=(t-this.oldTime)/1e3,this.oldTime=t,this.elapsedTime+=e}return e}},pf=class{constructor(e=1,t=0,n=0){this.radius=e,this.phi=t,this.theta=n}set(e,t,n){return this.radius=e,this.phi=t,this.theta=n,this}copy(e){return this.radius=e.radius,this.phi=e.phi,this.theta=e.theta,this}makeSafe(){return this.phi=ot(this.phi,1e-6,Math.PI-1e-6),this}setFromVector3(e){return this.setFromCartesianCoords(e.x,e.y,e.z)}setFromCartesianCoords(e,t,n){return this.radius=Math.sqrt(e*e+t*t+n*n),this.radius===0?(this.theta=0,this.phi=0):(this.theta=Math.atan2(e,n),this.phi=Math.acos(ot(t/this.radius,-1,1))),this}clone(){return new this.constructor().copy(this)}},mf=class{constructor(e=1,t=0,n=0){this.radius=e,this.theta=t,this.y=n}set(e,t,n){return this.radius=e,this.theta=t,this.y=n,this}copy(e){return this.radius=e.radius,this.theta=e.theta,this.y=e.y,this}setFromVector3(e){return this.setFromCartesianCoords(e.x,e.y,e.z)}setFromCartesianCoords(e,t,n){return this.radius=Math.sqrt(e*e+n*n),this.theta=Math.atan2(e,n),this.y=t,this}clone(){return new this.constructor().copy(this)}},wm=class wm{constructor(e,t,n,r){this.elements=[1,0,0,1],e!==void 0&&this.set(e,t,n,r)}identity(){return this.set(1,0,0,1),this}fromArray(e,t=0){for(let n=0;n<4;n++)this.elements[n]=e[n+t];return this}set(e,t,n,r){let s=this.elements;return s[0]=e,s[2]=t,s[1]=n,s[3]=r,this}};wm.prototype.isMatrix2=!0;var gf=wm,Ag=new he,Mc=class{constructor(e=new he(1/0,1/0),t=new he(-1/0,-1/0)){this.isBox2=!0,this.min=e,this.max=t}set(e,t){return this.min.copy(e),this.max.copy(t),this}setFromPoints(e){this.makeEmpty();for(let t=0,n=e.length;t<n;t++)this.expandByPoint(e[t]);return this}setFromCenterAndSize(e,t){let n=Ag.copy(t).multiplyScalar(.5);return this.min.copy(e).sub(n),this.max.copy(e).add(n),this}clone(){return new this.constructor().copy(this)}copy(e){return this.min.copy(e.min),this.max.copy(e.max),this}makeEmpty(){return this.min.x=this.min.y=1/0,this.max.x=this.max.y=-1/0,this}isEmpty(){return this.max.x<this.min.x||this.max.y<this.min.y}getCenter(e){return this.isEmpty()?e.set(0,0):e.addVectors(this.min,this.max).multiplyScalar(.5)}getSize(e){return this.isEmpty()?e.set(0,0):e.subVectors(this.max,this.min)}expandByPoint(e){return this.min.min(e),this.max.max(e),this}expandByVector(e){return this.min.sub(e),this.max.add(e),this}expandByScalar(e){return this.min.addScalar(-e),this.max.addScalar(e),this}containsPoint(e){return e.x>=this.min.x&&e.x<=this.max.x&&e.y>=this.min.y&&e.y<=this.max.y}containsBox(e){return this.min.x<=e.min.x&&e.max.x<=this.max.x&&this.min.y<=e.min.y&&e.max.y<=this.max.y}getParameter(e,t){return t.set((e.x-this.min.x)/(this.max.x-this.min.x),(e.y-this.min.y)/(this.max.y-this.min.y))}intersectsBox(e){return e.max.x>=this.min.x&&e.min.x<=this.max.x&&e.max.y>=this.min.y&&e.min.y<=this.max.y}clampPoint(e,t){return t.copy(e).clamp(this.min,this.max)}distanceToPoint(e){return this.clampPoint(e,Ag).distanceTo(e)}intersect(e){return this.min.max(e.min),this.max.min(e.max),this.isEmpty()&&this.makeEmpty(),this}union(e){return this.min.min(e.min),this.max.max(e.max),this}translate(e){return this.min.add(e),this.max.add(e),this}equals(e){return e.min.equals(this.min)&&e.max.equals(this.max)}},Eg=new R,yh=new R,Io=new R,Lo=new R,fp=new R,S1=new R,b1=new R,vf=class{constructor(e=new R,t=new R){this.start=e,this.end=t}set(e,t){return this.start.copy(e),this.end.copy(t),this}copy(e){return this.start.copy(e.start),this.end.copy(e.end),this}getCenter(e){return e.addVectors(this.start,this.end).multiplyScalar(.5)}delta(e){return e.subVectors(this.end,this.start)}distanceSq(){return this.start.distanceToSquared(this.end)}distance(){return this.start.distanceTo(this.end)}at(e,t){return this.delta(t).multiplyScalar(e).add(this.start)}closestPointToPointParameter(e,t){Eg.subVectors(e,this.start),yh.subVectors(this.end,this.start);let n=yh.dot(yh);if(n===0)return 0;let s=yh.dot(Eg)/n;return t&&(s=ot(s,0,1)),s}closestPointToPoint(e,t,n){let r=this.closestPointToPointParameter(e,t);return this.delta(n).multiplyScalar(r).add(this.start)}distanceSqToLine3(e,t=S1,n=b1){let r=10000000000000001e-32,s,o,a=this.start,l=e.start,c=this.end,u=e.end;Io.subVectors(c,a),Lo.subVectors(u,l),fp.subVectors(a,l);let f=Io.dot(Io),h=Lo.dot(Lo),d=Lo.dot(fp);if(f<=r&&h<=r)return t.copy(a),n.copy(l),t.sub(n),t.dot(t);if(f<=r)s=0,o=d/h,o=ot(o,0,1);else{let p=Io.dot(fp);if(h<=r)o=0,s=ot(-p/f,0,1);else{let v=Io.dot(Lo),g=f*h-v*v;g!==0?s=ot((v*d-p*h)/g,0,1):s=0,o=(v*s+d)/h,o<0?(o=0,s=ot(-p/f,0,1)):o>1&&(o=1,s=ot((v-p)/f,0,1))}}return t.copy(a).addScaledVector(Io,s),n.copy(l).addScaledVector(Lo,o),t.distanceToSquared(n)}applyMatrix4(e){return this.start.applyMatrix4(e),this.end.applyMatrix4(e),this}equals(e){return e.start.equals(this.start)&&e.end.equals(this.end)}clone(){return new this.constructor().copy(this)}},Cg=new R,xf=class extends At{constructor(e,t){super(),this.light=e,this.matrixAutoUpdate=!1,this.color=t,this.type="SpotLightHelper";let n=new et,r=[0,0,0,0,0,1,0,0,0,1,0,1,0,0,0,-1,0,1,0,0,0,0,1,1,0,0,0,0,-1,1];for(let o=0,a=1,l=32;o<l;o++,a++){let c=o/l*Math.PI*2,u=a/l*Math.PI*2;r.push(Math.cos(c),Math.sin(c),1,Math.cos(u),Math.sin(u),1)}n.setAttribute("position",new Ve(r,3));let s=new dn({fog:!1,toneMapped:!1});this.cone=new ci(n,s),this.add(this.cone),this.update()}dispose(){super.dispose(),this.cone.geometry.dispose(),this.cone.material.dispose()}update(){this.light.updateWorldMatrix(!0,!1),this.light.target.updateWorldMatrix(!0,!1),this.parent?(this.parent.updateWorldMatrix(!0),this.matrix.copy(this.parent.matrixWorld).invert().multiply(this.light.matrixWorld)):this.matrix.copy(this.light.matrixWorld),this.matrixWorldNeedsUpdate=!0;let e=this.light.distance?this.light.distance:1e3,t=e*Math.tan(this.light.angle);this.cone.scale.set(t,t,e),Cg.setFromMatrixPosition(this.light.target.matrixWorld),this.cone.lookAt(Cg),this.color!==void 0?this.cone.material.color.set(this.color):this.cone.material.color.copy(this.light.color)}},Wr=new R,_h=new it,dp=new it,yf=class extends ci{constructor(e){let t=Ov(e),n=new et,r=[],s=[];for(let c=0;c<t.length;c++){let u=t[c];u.parent&&u.parent.isBone&&(r.push(0,0,0),r.push(0,0,0),s.push(0,0,0),s.push(0,0,0))}n.setAttribute("position",new Ve(r,3)),n.setAttribute("color",new Ve(s,3));let o=new dn({vertexColors:!0,depthTest:!1,depthWrite:!1,toneMapped:!1,transparent:!0});super(n,o),this.isSkeletonHelper=!0,this.type="SkeletonHelper",this.root=e,this.bones=t,this.matrix=e.matrixWorld,this.matrixAutoUpdate=!1;let a=new be(255),l=new be(65280);this.setColors(a,l)}updateMatrixWorld(e){let t=this.bones,n=this.geometry,r=n.getAttribute("position");dp.copy(this.root.matrixWorld).invert();for(let s=0,o=0;s<t.length;s++){let a=t[s];a.parent&&a.parent.isBone&&(_h.multiplyMatrices(dp,a.matrixWorld),Wr.setFromMatrixPosition(_h),r.setXYZ(o,Wr.x,Wr.y,Wr.z),_h.multiplyMatrices(dp,a.parent.matrixWorld),Wr.setFromMatrixPosition(_h),r.setXYZ(o+1,Wr.x,Wr.y,Wr.z),o+=2)}n.getAttribute("position").needsUpdate=!0,super.updateMatrixWorld(e)}setColors(e,t){let r=this.geometry.getAttribute("color");for(let s=0;s<r.count;s+=2)r.setXYZ(s,e.r,e.g,e.b),r.setXYZ(s+1,t.r,t.g,t.b);return r.needsUpdate=!0,this}dispose(){super.dispose(),this.geometry.dispose(),this.material.dispose()}};function Ov(i){let e=[];i.isBone===!0&&e.push(i);for(let t=0;t<i.children.length;t++)e.push(...Ov(i.children[t]));return e}var _f=class extends at{constructor(e,t,n){let r=new mn(t,4,2),s=new Hn({wireframe:!0,fog:!1,toneMapped:!1});super(r,s),this.light=e,this.color=n,this.type="PointLightHelper",this.matrix=this.light.matrixWorld,this.matrixAutoUpdate=!1,this.update()}dispose(){super.dispose(),this.geometry.dispose(),this.material.dispose()}update(){this.matrixWorldNeedsUpdate=!0,this.light.updateWorldMatrix(!0,!1),this.color!==void 0?this.material.color.set(this.color):this.material.color.copy(this.light.color)}},w1=new R,Rg=new be,Pg=new be,Mf=class extends At{constructor(e,t,n){super(),this.light=e,this.matrix=e.matrixWorld,this.matrixAutoUpdate=!1,this.color=n,this.type="HemisphereLightHelper";let r=new na(t);r.rotateY(Math.PI*.5),this.material=new Hn({wireframe:!0,fog:!1,toneMapped:!1}),this.color===void 0&&(this.material.vertexColors=!0);let s=r.getAttribute("position"),o=new Float32Array(s.count*3);r.setAttribute("color",new ht(o,3)),this.add(new at(r,this.material)),this.update()}dispose(){super.dispose(),this.children[0].geometry.dispose(),this.children[0].material.dispose()}update(){let e=this.children[0];if(this.color!==void 0)this.material.color.set(this.color);else{let t=e.geometry.getAttribute("color");Rg.copy(this.light.color),Pg.copy(this.light.groundColor);for(let n=0,r=t.count;n<r;n++){let s=n<r/2?Rg:Pg;t.setXYZ(n,s.r,s.g,s.b)}t.needsUpdate=!0}this.matrixWorldNeedsUpdate=!0,this.light.updateWorldMatrix(!0,!1),e.lookAt(w1.setFromMatrixPosition(this.light.matrixWorld).negate())}},Sf=class extends ci{constructor(e=10,t=10,n=4473924,r=8947848){n=new be(n),r=new be(r);let s=t/2,o=e/t,a=e/2,l=[],c=[];for(let h=0,d=0,p=-a;h<=t;h++,p+=o){l.push(-a,0,p,a,0,p),l.push(p,0,-a,p,0,a);let v=h===s?n:r;v.toArray(c,d),d+=3,v.toArray(c,d),d+=3,v.toArray(c,d),d+=3,v.toArray(c,d),d+=3}let u=new et;u.setAttribute("position",new Ve(l,3)),u.setAttribute("color",new Ve(c,3));let f=new dn({vertexColors:!0,toneMapped:!1});super(u,f),this.type="GridHelper"}dispose(){super.dispose(),this.geometry.dispose(),this.material.dispose()}},bf=class extends ci{constructor(e=10,t=16,n=8,r=64,s=4473924,o=8947848){s=new be(s),o=new be(o);let a=[],l=[];if(t>1)for(let f=0;f<t;f++){let h=f/t*(Math.PI*2),d=Math.sin(h)*e,p=Math.cos(h)*e;a.push(0,0,0),a.push(d,0,p);let v=f&1?s:o;l.push(v.r,v.g,v.b),l.push(v.r,v.g,v.b)}for(let f=0;f<n;f++){let h=f&1?s:o,d=e-e/n*f;for(let p=0;p<r;p++){let v=p/r*(Math.PI*2),g=Math.sin(v)*d,m=Math.cos(v)*d;a.push(g,0,m),l.push(h.r,h.g,h.b),v=(p+1)/r*(Math.PI*2),g=Math.sin(v)*d,m=Math.cos(v)*d,a.push(g,0,m),l.push(h.r,h.g,h.b)}}let c=new et;c.setAttribute("position",new Ve(a,3)),c.setAttribute("color",new Ve(l,3));let u=new dn({vertexColors:!0,toneMapped:!1});super(c,u),this.type="PolarGridHelper"}dispose(){super.dispose(),this.geometry.dispose(),this.material.dispose()}},Ig=new R,Mh=new R,Lg=new R,wf=class extends At{constructor(e,t,n){super(),this.light=e,this.matrix=e.matrixWorld,this.matrixAutoUpdate=!1,this.color=n,this.type="DirectionalLightHelper",t===void 0&&(t=1);let r=new et;r.setAttribute("position",new Ve([-t,t,0,t,t,0,t,-t,0,-t,-t,0,-t,t,0],3));let s=new dn({fog:!1,toneMapped:!1});this.lightPlane=new Bi(r,s),this.add(this.lightPlane),r=new et,r.setAttribute("position",new Ve([0,0,0,0,0,1],3)),this.targetLine=new Bi(r,s),this.add(this.targetLine),this.update()}dispose(){super.dispose(),this.lightPlane.geometry.dispose(),this.lightPlane.material.dispose(),this.targetLine.geometry.dispose(),this.targetLine.material.dispose()}update(){this.matrixWorldNeedsUpdate=!0,this.light.updateWorldMatrix(!0,!1),this.light.target.updateWorldMatrix(!0,!1),Ig.setFromMatrixPosition(this.light.matrixWorld),Mh.setFromMatrixPosition(this.light.target.matrixWorld),Lg.subVectors(Mh,Ig),this.lightPlane.lookAt(Mh),this.color!==void 0?(this.lightPlane.material.color.set(this.color),this.targetLine.material.color.set(this.color)):(this.lightPlane.material.color.copy(this.light.color),this.targetLine.material.color.copy(this.light.color)),this.targetLine.lookAt(Mh),this.targetLine.scale.z=Lg.length()}},Sh=new R,$t=new Hs,Tf=class extends ci{constructor(e){let t=new et,n=new dn({color:16777215,vertexColors:!0,toneMapped:!1}),r=[],s=[],o={};a("n1","n2"),a("n2","n4"),a("n4","n3"),a("n3","n1"),a("f1","f2"),a("f2","f4"),a("f4","f3"),a("f3","f1"),a("n1","f1"),a("n2","f2"),a("n3","f3"),a("n4","f4"),a("p","n1"),a("p","n2"),a("p","n3"),a("p","n4"),a("u1","u2"),a("u2","u3"),a("u3","u1"),a("c","t"),a("p","c"),a("cn1","cn2"),a("cn3","cn4"),a("cf1","cf2"),a("cf3","cf4");function a(p,v){l(p),l(v)}function l(p){r.push(0,0,0),s.push(0,0,0),o[p]===void 0&&(o[p]=[]),o[p].push(r.length/3-1)}t.setAttribute("position",new Ve(r,3)),t.setAttribute("color",new Ve(s,3)),super(t,n),this.type="CameraHelper",this.camera=e,this.camera.updateProjectionMatrix&&this.camera.updateProjectionMatrix(),this.matrix=e.matrixWorld,this.matrixAutoUpdate=!1,this.pointMap=o,this.update();let c=new be(16755200),u=new be(16711680),f=new be(43775),h=new be(16777215),d=new be(3355443);this.setColors(c,u,f,h,d)}setColors(e,t,n,r,s){let a=this.geometry.getAttribute("color");return a.setXYZ(0,e.r,e.g,e.b),a.setXYZ(1,e.r,e.g,e.b),a.setXYZ(2,e.r,e.g,e.b),a.setXYZ(3,e.r,e.g,e.b),a.setXYZ(4,e.r,e.g,e.b),a.setXYZ(5,e.r,e.g,e.b),a.setXYZ(6,e.r,e.g,e.b),a.setXYZ(7,e.r,e.g,e.b),a.setXYZ(8,e.r,e.g,e.b),a.setXYZ(9,e.r,e.g,e.b),a.setXYZ(10,e.r,e.g,e.b),a.setXYZ(11,e.r,e.g,e.b),a.setXYZ(12,e.r,e.g,e.b),a.setXYZ(13,e.r,e.g,e.b),a.setXYZ(14,e.r,e.g,e.b),a.setXYZ(15,e.r,e.g,e.b),a.setXYZ(16,e.r,e.g,e.b),a.setXYZ(17,e.r,e.g,e.b),a.setXYZ(18,e.r,e.g,e.b),a.setXYZ(19,e.r,e.g,e.b),a.setXYZ(20,e.r,e.g,e.b),a.setXYZ(21,e.r,e.g,e.b),a.setXYZ(22,e.r,e.g,e.b),a.setXYZ(23,e.r,e.g,e.b),a.setXYZ(24,t.r,t.g,t.b),a.setXYZ(25,t.r,t.g,t.b),a.setXYZ(26,t.r,t.g,t.b),a.setXYZ(27,t.r,t.g,t.b),a.setXYZ(28,t.r,t.g,t.b),a.setXYZ(29,t.r,t.g,t.b),a.setXYZ(30,t.r,t.g,t.b),a.setXYZ(31,t.r,t.g,t.b),a.setXYZ(32,n.r,n.g,n.b),a.setXYZ(33,n.r,n.g,n.b),a.setXYZ(34,n.r,n.g,n.b),a.setXYZ(35,n.r,n.g,n.b),a.setXYZ(36,n.r,n.g,n.b),a.setXYZ(37,n.r,n.g,n.b),a.setXYZ(38,r.r,r.g,r.b),a.setXYZ(39,r.r,r.g,r.b),a.setXYZ(40,s.r,s.g,s.b),a.setXYZ(41,s.r,s.g,s.b),a.setXYZ(42,s.r,s.g,s.b),a.setXYZ(43,s.r,s.g,s.b),a.setXYZ(44,s.r,s.g,s.b),a.setXYZ(45,s.r,s.g,s.b),a.setXYZ(46,s.r,s.g,s.b),a.setXYZ(47,s.r,s.g,s.b),a.setXYZ(48,s.r,s.g,s.b),a.setXYZ(49,s.r,s.g,s.b),a.needsUpdate=!0,this}update(){let e=this.geometry,t=this.pointMap,n=1,r=1,s,o;if($t.projectionMatrixInverse.copy(this.camera.projectionMatrixInverse),this.camera.reversedDepth===!0)s=1,o=0;else if(this.camera.coordinateSystem===Kn)s=-1,o=1;else if(this.camera.coordinateSystem===Zr)s=0,o=1;else throw new Error("THREE.CameraHelper.update(): Invalid coordinate system: "+this.camera.coordinateSystem);tn("c",t,e,$t,0,0,s),tn("t",t,e,$t,0,0,o),tn("n1",t,e,$t,-n,-r,s),tn("n2",t,e,$t,n,-r,s),tn("n3",t,e,$t,-n,r,s),tn("n4",t,e,$t,n,r,s),tn("f1",t,e,$t,-n,-r,o),tn("f2",t,e,$t,n,-r,o),tn("f3",t,e,$t,-n,r,o),tn("f4",t,e,$t,n,r,o),tn("u1",t,e,$t,n*.7,r*1.1,s),tn("u2",t,e,$t,-n*.7,r*1.1,s),tn("u3",t,e,$t,0,r*2,s),tn("cf1",t,e,$t,-n,0,o),tn("cf2",t,e,$t,n,0,o),tn("cf3",t,e,$t,0,-r,o),tn("cf4",t,e,$t,0,r,o),tn("cn1",t,e,$t,-n,0,s),tn("cn2",t,e,$t,n,0,s),tn("cn3",t,e,$t,0,-r,s),tn("cn4",t,e,$t,0,r,s),e.getAttribute("position").needsUpdate=!0}dispose(){super.dispose(),this.geometry.dispose(),this.material.dispose()}};function tn(i,e,t,n,r,s,o){Sh.set(r,s,o).unproject(n);let a=e[i];if(a!==void 0){let l=t.getAttribute("position");for(let c=0,u=a.length;c<u;c++)l.setXYZ(a[c],Sh.x,Sh.y,Sh.z)}}var bh=new cn,Af=class extends ci{constructor(e,t=16776960){let n=new Uint16Array([0,1,1,2,2,3,3,0,4,5,5,6,6,7,7,4,0,4,1,5,2,6,3,7]),r=new Float32Array(24),s=new et;s.setIndex(new ht(n,1)),s.setAttribute("position",new ht(r,3)),super(s,new dn({color:t,toneMapped:!1})),this.object=e,this.type="BoxHelper",this.matrixAutoUpdate=!1,this.update()}update(){if(this.object!==void 0&&bh.setFromObject(this.object),bh.isEmpty())return;let e=bh.min,t=bh.max,n=this.geometry.attributes.position,r=n.array;r[0]=t.x,r[1]=t.y,r[2]=t.z,r[3]=e.x,r[4]=t.y,r[5]=t.z,r[6]=e.x,r[7]=e.y,r[8]=t.z,r[9]=t.x,r[10]=e.y,r[11]=t.z,r[12]=t.x,r[13]=t.y,r[14]=e.z,r[15]=e.x,r[16]=t.y,r[17]=e.z,r[18]=e.x,r[19]=e.y,r[20]=e.z,r[21]=t.x,r[22]=e.y,r[23]=e.z,n.needsUpdate=!0,this.geometry.computeBoundingSphere()}setFromObject(e){return this.object=e,this.update(),this}copy(e,t){return super.copy(e,t),this.object=e.object,this}dispose(){super.dispose(),this.geometry.dispose(),this.material.dispose()}},Ef=class extends ci{constructor(e,t=16776960){let n=new Uint16Array([0,1,1,2,2,3,3,0,4,5,5,6,6,7,7,4,0,4,1,5,2,6,3,7]),r=[1,1,1,-1,1,1,-1,-1,1,1,-1,1,1,1,-1,-1,1,-1,-1,-1,-1,1,-1,-1],s=new et;s.setIndex(new ht(n,1)),s.setAttribute("position",new Ve(r,3)),super(s,new dn({color:t,toneMapped:!1})),this.box=e,this.type="Box3Helper",this.geometry.computeBoundingSphere()}updateMatrixWorld(e){let t=this.box;t.isEmpty()||(t.getCenter(this.position),t.getSize(this.scale),this.scale.multiplyScalar(.5),super.updateMatrixWorld(e))}dispose(){super.dispose(),this.geometry.dispose(),this.material.dispose()}},Cf=class extends Bi{constructor(e,t=1,n=16776960){let r=n,s=[1,-1,0,-1,1,0,-1,-1,0,1,1,0,-1,1,0,-1,-1,0,1,-1,0,1,1,0],o=new et;o.setAttribute("position",new Ve(s,3)),o.computeBoundingSphere(),super(o,new dn({color:r,toneMapped:!1})),this.type="PlaneHelper",this.plane=e,this.size=t;let a=[1,1,0,-1,1,0,-1,-1,0,1,1,0,-1,-1,0,1,-1,0],l=new et;l.setAttribute("position",new Ve(a,3)),l.computeBoundingSphere(),this.add(new at(l,new Hn({color:r,opacity:.2,transparent:!0,depthWrite:!1,toneMapped:!1})))}updateMatrixWorld(e){this.position.set(0,0,0),this.scale.set(.5*this.size,.5*this.size,1),this.lookAt(this.plane.normal),this.translateZ(-this.plane.constant),super.updateMatrixWorld(e)}dispose(){super.dispose(),this.geometry.dispose(),this.material.dispose(),this.children[0].geometry.dispose(),this.children[0].material.dispose()}},Dg=new R,wh,pp,Rf=class extends At{constructor(e=new R(0,0,1),t=new R(0,0,0),n=1,r=16776960,s=n*.2,o=s*.2){super(),this.type="ArrowHelper",wh===void 0&&(wh=new et,wh.setAttribute("position",new Ve([0,0,0,0,1,0],3)),pp=new Qn(.5,1,5,1),pp.translate(0,-.5,0)),this.position.copy(t),this.line=new Bi(wh,new dn({color:r,toneMapped:!1})),this.line.matrixAutoUpdate=!1,this.add(this.line),this.cone=new at(pp,new Hn({color:r,toneMapped:!1})),this.cone.matrixAutoUpdate=!1,this.add(this.cone),this.setDirection(e),this.setLength(n,s,o)}setDirection(e){if(e.y>.99999)this.quaternion.set(0,0,0,1);else if(e.y<-.99999)this.quaternion.set(1,0,0,0);else{Dg.set(e.z,0,-e.x).normalize();let t=Math.acos(e.y);this.quaternion.setFromAxisAngle(Dg,t)}}setLength(e,t=e*.2,n=t*.2){this.line.scale.set(1,Math.max(1e-4,e-t),1),this.line.updateMatrix(),this.cone.scale.set(n,t,n),this.cone.position.y=e,this.cone.updateMatrix()}setColor(e){this.line.material.color.set(e),this.cone.material.color.set(e)}copy(e){return super.copy(e,!1),this.line.copy(e.line),this.cone.copy(e.cone),this}dispose(){super.dispose(),this.line.geometry.dispose(),this.line.material.dispose(),this.cone.geometry.dispose(),this.cone.material.dispose()}},Pf=class extends ci{constructor(e=1){let t=[0,0,0,e,0,0,0,0,0,0,e,0,0,0,0,0,0,e],n=[1,0,0,1,.6,0,0,1,0,.6,1,0,0,0,1,0,.6,1],r=new et;r.setAttribute("position",new Ve(t,3)),r.setAttribute("color",new Ve(n,3));let s=new dn({vertexColors:!0,toneMapped:!1});super(r,s),this.type="AxesHelper"}setColors(e,t,n){let r=new be,s=this.geometry.attributes.color.array;return r.set(e),r.toArray(s,0),r.toArray(s,3),r.set(t),r.toArray(s,6),r.toArray(s,9),r.set(n),r.toArray(s,12),r.toArray(s,15),this.geometry.attributes.color.needsUpdate=!0,this}dispose(){super.dispose(),this.geometry.dispose(),this.material.dispose()}},If=class{constructor(){this.type="ShapePath",this.color=new be,this.subPaths=[],this.currentPath=null,this.userData={}}moveTo(e,t){return this.currentPath=new jr,this.subPaths.push(this.currentPath),this.currentPath.moveTo(e,t),this}lineTo(e,t){return this.currentPath.lineTo(e,t),this}quadraticCurveTo(e,t,n,r){return this.currentPath.quadraticCurveTo(e,t,n,r),this}bezierCurveTo(e,t,n,r,s,o){return this.currentPath.bezierCurveTo(e,t,n,r,s,o),this}splineThru(e){return this.currentPath.splineThru(e),this}toShapes(){function e(l,c){let u=!1,f=c.length;for(let h=0,d=f-1;h<f;d=h++){let p=c[h],v=c[d];p.y>l.y!=v.y>l.y&&l.x<(v.x-p.x)*(l.y-p.y)/(v.y-p.y)+p.x&&(u=!u)}return u}function t(l,c){let u=c.getCenter(new he);if(e(u,l))return u;let f=u.y,h=[],d=l.length;for(let p=0;p<d;p++){let v=l[p],g=l[(p+1)%d];if(v.y>f!=g.y>f){let m=v.x+(f-v.y)*(g.x-v.x)/(g.y-v.y);h.push(m)}}return h.length>1&&(h.sort((p,v)=>p-v),u.x=(h[0]+h[1])/2),u}let n=this.userData.style&&this.userData.style.fillRule||"nonzero";n!=="nonzero"&&n!=="evenodd"&&(Ge('Fill-rule "'+n+'" is not supported, falling back to "nonzero".'),n="nonzero");let r=n==="nonzero"?(l=>l!==0):(l=>(l&1)!==0),s=[];for(let l of this.subPaths){let c=l.getPoints();if(c.length<3)continue;let u=bi.area(c);if(u===0)continue;let f=new Mc;for(let h=0;h<c.length;h++)f.expandByPoint(c[h]);s.push({subPath:l,points:c,boundingBox:f,interiorPoint:t(c,f),absArea:Math.abs(u),winding:u<0?-1:1,container:null,exclude:!1,role:null})}s.sort((l,c)=>c.absArea-l.absArea);for(let l=0;l<s.length;l++){let c=s[l],u=0;for(let f=l-1;f>=0;f--){let h=s[f];if(h.boundingBox.containsBox(c.boundingBox)&&e(c.interiorPoint,h.points)){c.container=h.exclude?h.container:h,u=h.winding,c.winding+=u;break}}r(c.winding)===r(u)&&(c.exclude=!0)}for(let l of s)l.exclude||(l.role=l.container===null||l.container.role==="hole"?"outer":"hole");let o=[],a=new Map;for(let l of s){if(l.exclude||l.role!=="outer")continue;let c=new Ti;c.curves=l.subPath.curves,o.push(c),a.set(l,c)}for(let l of s){if(l.exclude||l.role!=="hole")continue;let c=a.get(l.container);if(!c)continue;let u=new jr;u.curves=l.subPath.curves,c.holes.push(u)}return o}},Lf=class extends jn{constructor(e,t=null){super(),this.object=e,this.domElement=t,this.enabled=!0,this.state=-1,this.keys={},this.mouseButtons={LEFT:null,MIDDLE:null,RIGHT:null},this.touches={ONE:null,TWO:null}}connect(e){this.domElement!==null&&this.disconnect(),this.domElement=e}disconnect(){}dispose(){}update(){}};function T1(i,e){let t=i.image&&i.image.width?i.image.width/i.image.height:1;return t>e?(i.repeat.x=1,i.repeat.y=t/e,i.offset.x=0,i.offset.y=(1-i.repeat.y)/2):(i.repeat.x=e/t,i.repeat.y=1,i.offset.x=(1-i.repeat.x)/2,i.offset.y=0),i}function A1(i,e){let t=i.image&&i.image.width?i.image.width/i.image.height:1;return t>e?(i.repeat.x=e/t,i.repeat.y=1,i.offset.x=(1-i.repeat.x)/2,i.offset.y=0):(i.repeat.x=1,i.repeat.y=t/e,i.offset.x=0,i.offset.y=(1-i.repeat.y)/2),i}function E1(i){return i.repeat.x=1,i.repeat.y=1,i.offset.x=0,i.offset.y=0,i}function Jf(i,e,t,n){let r=C1(n);switch(t){case Xf:return i*e;case Ac:return i*e/r.components*r.byteLength;case Sa:return i*e/r.components*r.byteLength;case Ir:return i*e*2/r.components*r.byteLength;case Ec:return i*e*2/r.components*r.byteLength;case qf:return i*e*3/r.components*r.byteLength;case Pn:return i*e*4/r.components*r.byteLength;case Cc:return i*e*4/r.components*r.byteLength;case ba:case wa:return Math.floor((i+3)/4)*Math.floor((e+3)/4)*8;case Ta:case Aa:return Math.floor((i+3)/4)*Math.floor((e+3)/4)*16;case Pc:case Lc:return Math.max(i,16)*Math.max(e,8)/4;case Rc:case Ic:return Math.max(i,8)*Math.max(e,8)/2;case Dc:case Nc:case Uc:case Bc:return Math.floor((i+3)/4)*Math.floor((e+3)/4)*8;case Fc:case Ea:case Oc:return Math.floor((i+3)/4)*Math.floor((e+3)/4)*16;case zc:return Math.floor((i+3)/4)*Math.floor((e+3)/4)*16;case kc:return Math.floor((i+4)/5)*Math.floor((e+3)/4)*16;case Gc:return Math.floor((i+4)/5)*Math.floor((e+4)/5)*16;case Vc:return Math.floor((i+5)/6)*Math.floor((e+4)/5)*16;case Hc:return Math.floor((i+5)/6)*Math.floor((e+5)/6)*16;case Wc:return Math.floor((i+7)/8)*Math.floor((e+4)/5)*16;case Xc:return Math.floor((i+7)/8)*Math.floor((e+5)/6)*16;case qc:return Math.floor((i+7)/8)*Math.floor((e+7)/8)*16;case Yc:return Math.floor((i+9)/10)*Math.floor((e+4)/5)*16;case Zc:return Math.floor((i+9)/10)*Math.floor((e+5)/6)*16;case $c:return Math.floor((i+9)/10)*Math.floor((e+7)/8)*16;case Jc:return Math.floor((i+9)/10)*Math.floor((e+9)/10)*16;case Kc:return Math.floor((i+11)/12)*Math.floor((e+9)/10)*16;case jc:return Math.floor((i+11)/12)*Math.floor((e+11)/12)*16;case Qc:case eu:case tu:return Math.ceil(i/4)*Math.ceil(e/4)*16;case nu:case iu:return Math.ceil(i/4)*Math.ceil(e/4)*8;case Ca:case ru:return Math.ceil(i/4)*Math.ceil(e/4)*16}throw new Error(`Unable to determine texture byte length for ${t} format.`)}function C1(i){switch(i){case Xn:case Gf:return{byteLength:1,components:1};case Js:case Vf:case ln:return{byteLength:2,components:1};case wc:case Tc:return{byteLength:2,components:4};case hi:case bc:case Rn:return{byteLength:4,components:1};case Hf:case Wf:return{byteLength:4,components:3}}throw new Error(`THREE.TextureUtils: Unknown texture type ${i}.`)}var Df=class{static contain(e,t){return T1(e,t)}static cover(e,t){return A1(e,t)}static fill(e){return E1(e)}static getByteLength(e,t,n,r){return Jf(e,t,n,r)}};typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("register",{detail:{revision:"186"}}));typeof window<"u"&&(window.__THREE__?Ge("WARNING: Multiple instances of Three.js being imported."):window.__THREE__="186");function ox(){let i=null,e=!1,t=null,n=null;function r(s,o){n=i.requestAnimationFrame(r),t(s,o)}return{start:function(){e!==!0&&t!==null&&i!==null&&(n=i.requestAnimationFrame(r),e=!0)},stop:function(){i!==null&&i.cancelAnimationFrame(n),e=!1},setAnimationLoop:function(s){t=s},setContext:function(s){i=s}}}function R1(i){let e=new WeakMap;function t(a,l){let c=a.array,u=a.usage,f=c.byteLength,h=i.createBuffer();i.bindBuffer(l,h),i.bufferData(l,c,u),a.onUploadCallback();let d;if(c instanceof Float32Array)d=i.FLOAT;else if(typeof Float16Array<"u"&&c instanceof Float16Array)d=i.HALF_FLOAT;else if(c instanceof Uint16Array)a.isFloat16BufferAttribute?d=i.HALF_FLOAT:d=i.UNSIGNED_SHORT;else if(c instanceof Int16Array)d=i.SHORT;else if(c instanceof Uint32Array)d=i.UNSIGNED_INT;else if(c instanceof Int32Array)d=i.INT;else if(c instanceof Int8Array)d=i.BYTE;else if(c instanceof Uint8Array)d=i.UNSIGNED_BYTE;else if(c instanceof Uint8ClampedArray)d=i.UNSIGNED_BYTE;else throw new Error("THREE.WebGLAttributes: Unsupported buffer data format: "+c);return{buffer:h,type:d,bytesPerElement:c.BYTES_PER_ELEMENT,version:a.version,size:f}}function n(a,l,c){let u=l.array,f=l.updateRanges;if(i.bindBuffer(c,a),f.length===0)i.bufferSubData(c,0,u);else{f.sort((d,p)=>d.start-p.start);let h=0;for(let d=1;d<f.length;d++){let p=f[h],v=f[d];v.start<=p.start+p.count+1?p.count=Math.max(p.count,v.start+v.count-p.start):(++h,f[h]=v)}f.length=h+1;for(let d=0,p=f.length;d<p;d++){let v=f[d];i.bufferSubData(c,v.start*u.BYTES_PER_ELEMENT,u,v.start,v.count)}l.clearUpdateRanges()}l.onUploadCallback()}function r(a){return a.isInterleavedBufferAttribute&&(a=a.data),e.get(a)}function s(a){a.isInterleavedBufferAttribute&&(a=a.data);let l=e.get(a);l&&(i.deleteBuffer(l.buffer),e.delete(a))}function o(a,l){if(a.isInterleavedBufferAttribute&&(a=a.data),a.isGLBufferAttribute){let u=e.get(a);(!u||u.version<a.version)&&e.set(a,{buffer:a.buffer,type:a.type,bytesPerElement:a.elementSize,version:a.version});return}let c=e.get(a);if(c===void 0)e.set(a,t(a,l));else if(c.version<a.version){if(c.size!==a.array.byteLength)throw new Error("THREE.WebGLAttributes: The size of the buffer attribute's array buffer does not match the original size. Resizing buffer attributes is not supported.");n(c.buffer,a,l),c.version=a.version}}return{get:r,remove:s,update:o}}var P1=`#ifdef USE_ALPHAHASH
	if ( diffuseColor.a < getAlphaHashThreshold( vPosition ) ) discard;
#endif`,I1=`#ifdef USE_ALPHAHASH
	const float ALPHA_HASH_SCALE = 0.05;
	float hash2D( vec2 value ) {
		return fract( 1.0e4 * sin( 17.0 * value.x + 0.1 * value.y ) * ( 0.1 + abs( sin( 13.0 * value.y + value.x ) ) ) );
	}
	float hash3D( vec3 value ) {
		return hash2D( vec2( hash2D( value.xy ), value.z ) );
	}
	float getAlphaHashThreshold( vec3 position ) {
		float maxDeriv = max(
			length( dFdx( position.xyz ) ),
			length( dFdy( position.xyz ) )
		);
		float pixScale = 1.0 / ( ALPHA_HASH_SCALE * maxDeriv );
		vec2 pixScales = vec2(
			exp2( floor( log2( pixScale ) ) ),
			exp2( ceil( log2( pixScale ) ) )
		);
		vec2 alpha = vec2(
			hash3D( floor( pixScales.x * position.xyz ) ),
			hash3D( floor( pixScales.y * position.xyz ) )
		);
		float lerpFactor = fract( log2( pixScale ) );
		float x = ( 1.0 - lerpFactor ) * alpha.x + lerpFactor * alpha.y;
		float a = min( lerpFactor, 1.0 - lerpFactor );
		vec3 cases = vec3(
			x * x / ( 2.0 * a * ( 1.0 - a ) ),
			( x - 0.5 * a ) / ( 1.0 - a ),
			1.0 - ( ( 1.0 - x ) * ( 1.0 - x ) / ( 2.0 * a * ( 1.0 - a ) ) )
		);
		float threshold = ( x < ( 1.0 - a ) )
			? ( ( x < a ) ? cases.x : cases.y )
			: cases.z;
		return clamp( threshold , 1.0e-6, 1.0 );
	}
#endif`,L1=`#ifdef USE_ALPHAMAP
	diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).g;
#endif`,D1=`#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,N1=`#ifdef USE_ALPHATEST
	#ifdef ALPHA_TO_COVERAGE
	diffuseColor.a = smoothstep( alphaTest, alphaTest + fwidth( diffuseColor.a ), diffuseColor.a );
	if ( diffuseColor.a == 0.0 ) discard;
	#else
	if ( diffuseColor.a < alphaTest ) discard;
	#endif
#endif`,F1=`#ifdef USE_ALPHATEST
	uniform float alphaTest;
#endif`,U1=`#ifdef USE_AOMAP
	float ambientOcclusion = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;
	reflectedLight.indirectDiffuse *= ambientOcclusion;
	#if defined( USE_CLEARCOAT ) 
		clearcoatSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_SHEEN ) 
		sheenSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD )
		float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
	#endif
#endif`,B1=`#ifdef USE_AOMAP
	uniform sampler2D aoMap;
	uniform float aoMapIntensity;
#endif`,O1=`#ifdef USE_BATCHING
	#if ! defined( GL_ANGLE_multi_draw )
	#define gl_DrawID _gl_DrawID
	uniform int _gl_DrawID;
	#endif
	uniform highp sampler2D batchingTexture;
	uniform highp usampler2D batchingIdTexture;
	mat4 getBatchingMatrix( const in float i ) {
		int size = textureSize( batchingTexture, 0 ).x;
		int j = int( i ) * 4;
		int x = j % size;
		int y = j / size;
		vec4 v1 = texelFetch( batchingTexture, ivec2( x, y ), 0 );
		vec4 v2 = texelFetch( batchingTexture, ivec2( x + 1, y ), 0 );
		vec4 v3 = texelFetch( batchingTexture, ivec2( x + 2, y ), 0 );
		vec4 v4 = texelFetch( batchingTexture, ivec2( x + 3, y ), 0 );
		return mat4( v1, v2, v3, v4 );
	}
	float getIndirectIndex( const in int i ) {
		int size = textureSize( batchingIdTexture, 0 ).x;
		int x = i % size;
		int y = i / size;
		return float( texelFetch( batchingIdTexture, ivec2( x, y ), 0 ).r );
	}
#endif
#ifdef USE_BATCHING_COLOR
	uniform sampler2D batchingColorTexture;
	vec4 getBatchingColor( const in float i ) {
		int size = textureSize( batchingColorTexture, 0 ).x;
		int j = int( i );
		int x = j % size;
		int y = j / size;
		return texelFetch( batchingColorTexture, ivec2( x, y ), 0 );
	}
#endif`,z1=`#ifdef USE_BATCHING
	mat4 batchingMatrix = getBatchingMatrix( getIndirectIndex( gl_DrawID ) );
#endif`,k1=`vec3 transformed = vec3( position );
#ifdef USE_ALPHAHASH
	vPosition = vec3( position );
#endif`,G1=`vec3 objectNormal = vec3( normal );
#ifdef USE_TANGENT
	vec3 objectTangent = vec3( tangent.xyz );
#endif`,V1=`float G_BlinnPhong_Implicit( ) {
	return 0.25;
}
float D_BlinnPhong( const in float shininess, const in float dotNH ) {
	return RECIPROCAL_PI * ( shininess * 0.5 + 1.0 ) * pow( dotNH, shininess );
}
vec3 BRDF_BlinnPhong( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in vec3 specularColor, const in float shininess ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( specularColor, 1.0, dotVH );
	float G = G_BlinnPhong_Implicit( );
	float D = D_BlinnPhong( shininess, dotNH );
	return F * ( G * D );
} // validated`,H1=`#ifdef USE_IRIDESCENCE
	const mat3 XYZ_TO_REC709 = mat3(
		 3.2404542, -0.9692660,  0.0556434,
		-1.5371385,  1.8760108, -0.2040259,
		-0.4985314,  0.0415560,  1.0572252
	);
	vec3 Fresnel0ToIor( vec3 fresnel0 ) {
		vec3 sqrtF0 = sqrt( fresnel0 );
		return ( vec3( 1.0 ) + sqrtF0 ) / ( vec3( 1.0 ) - sqrtF0 );
	}
	vec3 IorToFresnel0( vec3 transmittedIor, float incidentIor ) {
		return pow2( ( transmittedIor - vec3( incidentIor ) ) / ( transmittedIor + vec3( incidentIor ) ) );
	}
	float IorToFresnel0( float transmittedIor, float incidentIor ) {
		return pow2( ( transmittedIor - incidentIor ) / ( transmittedIor + incidentIor ));
	}
	vec3 evalSensitivity( float OPD, vec3 shift ) {
		float phase = 2.0 * PI * OPD * 1.0e-9;
		vec3 val = vec3( 5.4856e-13, 4.4201e-13, 5.2481e-13 );
		vec3 pos = vec3( 1.6810e+06, 1.7953e+06, 2.2084e+06 );
		vec3 var = vec3( 4.3278e+09, 9.3046e+09, 6.6121e+09 );
		vec3 xyz = val * sqrt( 2.0 * PI * var ) * cos( pos * phase + shift ) * exp( - pow2( phase ) * var );
		xyz.x += 9.7470e-14 * sqrt( 2.0 * PI * 4.5282e+09 ) * cos( 2.2399e+06 * phase + shift[ 0 ] ) * exp( - 4.5282e+09 * pow2( phase ) );
		xyz /= 1.0685e-7;
		vec3 rgb = XYZ_TO_REC709 * xyz;
		return rgb;
	}
	vec3 evalIridescence( float outsideIOR, float eta2, float cosTheta1, float thinFilmThickness, vec3 baseF0 ) {
		vec3 I;
		float iridescenceIOR = mix( outsideIOR, eta2, smoothstep( 0.0, 0.03, thinFilmThickness ) );
		float sinTheta2Sq = pow2( outsideIOR / iridescenceIOR ) * ( 1.0 - pow2( cosTheta1 ) );
		float cosTheta2Sq = 1.0 - sinTheta2Sq;
		if ( cosTheta2Sq < 0.0 ) {
			return vec3( 1.0 );
		}
		float cosTheta2 = sqrt( cosTheta2Sq );
		float R0 = IorToFresnel0( iridescenceIOR, outsideIOR );
		float R12 = F_Schlick( R0, 1.0, cosTheta1 );
		float T121 = 1.0 - R12;
		float phi12 = 0.0;
		if ( iridescenceIOR < outsideIOR ) phi12 = PI;
		float phi21 = PI - phi12;
		vec3 baseIOR = Fresnel0ToIor( clamp( baseF0, 0.0, 0.9999 ) );		vec3 R1 = IorToFresnel0( baseIOR, iridescenceIOR );
		vec3 R23 = F_Schlick( R1, 1.0, cosTheta2 );
		vec3 phi23 = vec3( 0.0 );
		if ( baseIOR[ 0 ] < iridescenceIOR ) phi23[ 0 ] = PI;
		if ( baseIOR[ 1 ] < iridescenceIOR ) phi23[ 1 ] = PI;
		if ( baseIOR[ 2 ] < iridescenceIOR ) phi23[ 2 ] = PI;
		float OPD = 2.0 * iridescenceIOR * thinFilmThickness * cosTheta2;
		vec3 phi = vec3( phi21 ) + phi23;
		vec3 R123 = clamp( R12 * R23, 1e-5, 0.9999 );
		vec3 r123 = sqrt( R123 );
		vec3 Rs = pow2( T121 ) * R23 / ( vec3( 1.0 ) - R123 );
		vec3 C0 = R12 + Rs;
		I = C0;
		vec3 Cm = Rs - T121;
		for ( int m = 1; m <= 2; ++ m ) {
			Cm *= r123;
			vec3 Sm = 2.0 * evalSensitivity( float( m ) * OPD, float( m ) * phi );
			I += Cm * Sm;
		}
		return max( I, vec3( 0.0 ) );
	}
#endif`,W1=`#ifdef USE_BUMPMAP
	uniform sampler2D bumpMap;
	uniform float bumpScale;
	vec2 dHdxy_fwd() {
		vec2 dSTdx = dFdx( vBumpMapUv );
		vec2 dSTdy = dFdy( vBumpMapUv );
		float Hll = bumpScale * texture2D( bumpMap, vBumpMapUv ).x;
		float dBx = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdx ).x - Hll;
		float dBy = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdy ).x - Hll;
		return vec2( dBx, dBy );
	}
	vec3 perturbNormalArb( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection ) {
		vec3 vSigmaX = normalize( dFdx( surf_pos.xyz ) );
		vec3 vSigmaY = normalize( dFdy( surf_pos.xyz ) );
		vec3 vN = surf_norm;
		vec3 R1 = cross( vSigmaY, vN );
		vec3 R2 = cross( vN, vSigmaX );
		float fDet = dot( vSigmaX, R1 ) * faceDirection;
		vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
		return normalize( abs( fDet ) * surf_norm - vGrad );
	}
#endif`,X1=`#if NUM_CLIPPING_PLANES > 0
	vec4 plane;
	#ifdef ALPHA_TO_COVERAGE
		float distanceToPlane, distanceGradient;
		float clipOpacity = 1.0;
		#pragma unroll_loop_start
		for ( int i = 0; i < UNION_CLIPPING_PLANES; i ++ ) {
			plane = clippingPlanes[ i ];
			distanceToPlane = - dot( vClipPosition, plane.xyz ) + plane.w;
			distanceGradient = fwidth( distanceToPlane ) / 2.0;
			clipOpacity *= smoothstep( - distanceGradient, distanceGradient, distanceToPlane );
			if ( clipOpacity == 0.0 ) discard;
		}
		#pragma unroll_loop_end
		#if UNION_CLIPPING_PLANES < NUM_CLIPPING_PLANES
			float unionClipOpacity = 1.0;
			#pragma unroll_loop_start
			for ( int i = UNION_CLIPPING_PLANES; i < NUM_CLIPPING_PLANES; i ++ ) {
				plane = clippingPlanes[ i ];
				distanceToPlane = - dot( vClipPosition, plane.xyz ) + plane.w;
				distanceGradient = fwidth( distanceToPlane ) / 2.0;
				unionClipOpacity *= 1.0 - smoothstep( - distanceGradient, distanceGradient, distanceToPlane );
			}
			#pragma unroll_loop_end
			clipOpacity *= 1.0 - unionClipOpacity;
		#endif
		diffuseColor.a *= clipOpacity;
		if ( diffuseColor.a == 0.0 ) discard;
	#else
		#pragma unroll_loop_start
		for ( int i = 0; i < UNION_CLIPPING_PLANES; i ++ ) {
			plane = clippingPlanes[ i ];
			if ( dot( vClipPosition, plane.xyz ) > plane.w ) discard;
		}
		#pragma unroll_loop_end
		#if UNION_CLIPPING_PLANES < NUM_CLIPPING_PLANES
			bool clipped = true;
			#pragma unroll_loop_start
			for ( int i = UNION_CLIPPING_PLANES; i < NUM_CLIPPING_PLANES; i ++ ) {
				plane = clippingPlanes[ i ];
				clipped = ( dot( vClipPosition, plane.xyz ) > plane.w ) && clipped;
			}
			#pragma unroll_loop_end
			if ( clipped ) discard;
		#endif
	#endif
#endif`,q1=`#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
	uniform vec4 clippingPlanes[ NUM_CLIPPING_PLANES ];
#endif`,Y1=`#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
#endif`,Z1=`#if NUM_CLIPPING_PLANES > 0
	vClipPosition = - mvPosition.xyz;
#endif`,$1=`#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	diffuseColor *= vColor;
#endif`,J1=`#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	varying vec4 vColor;
#endif`,K1=`#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
	varying vec4 vColor;
#endif`,j1=`#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
	vColor = vec4( 1.0 );
#endif
#ifdef USE_COLOR_ALPHA
	vColor *= color;
#elif defined( USE_COLOR )
	vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
	vColor.rgb *= instanceColor.rgb;
#endif
#ifdef USE_BATCHING_COLOR
	vColor *= getBatchingColor( getIndirectIndex( gl_DrawID ) );
#endif`,Q1=`#define PI 3.141592653589793
#define PI2 6.283185307179586
#define PI_HALF 1.5707963267948966
#define RECIPROCAL_PI 0.3183098861837907
#define RECIPROCAL_PI2 0.15915494309189535
#define EPSILON 1e-6
#ifndef saturate
#define saturate( a ) clamp( a, 0.0, 1.0 )
#endif
#define whiteComplement( a ) ( 1.0 - saturate( a ) )
float pow2( const in float x ) { return x*x; }
vec3 pow2( const in vec3 x ) { return x*x; }
float pow3( const in float x ) { return x*x*x; }
float pow4( const in float x ) { float x2 = x*x; return x2*x2; }
float max3( const in vec3 v ) { return max( max( v.x, v.y ), v.z ); }
float average( const in vec3 v ) { return dot( v, vec3( 0.3333333 ) ); }
highp float rand( const in vec2 uv ) {
	const highp float a = 12.9898, b = 78.233, c = 43758.5453;
	highp float dt = dot( uv.xy, vec2( a,b ) ), sn = mod( dt, PI );
	return fract( sin( sn ) * c );
}
#ifdef HIGH_PRECISION
	float precisionSafeLength( vec3 v ) { return length( v ); }
#else
	float precisionSafeLength( vec3 v ) {
		float maxComponent = max3( abs( v ) );
		return length( v / maxComponent ) * maxComponent;
	}
#endif
struct IncidentLight {
	vec3 color;
	vec3 direction;
	bool visible;
};
struct ReflectedLight {
	vec3 directDiffuse;
	vec3 directSpecular;
	vec3 indirectDiffuse;
	vec3 indirectSpecular;
};
#ifdef USE_ALPHAHASH
	varying vec3 vPosition;
#endif
vec3 transformDirection( in vec3 dir, in mat4 matrix ) {
	return normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );
}
#define inverseTransformDirection transformDirectionByInverseViewMatrix
vec3 transformNormalByInverseViewMatrix( in vec3 normal, in mat4 viewMatrix ) {
	return normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
}
vec3 transformDirectionByInverseViewMatrix( in vec3 dir, in mat4 viewMatrix ) {
	return normalize( ( vec4( dir, 0.0 ) * viewMatrix ).xyz );
}
bool isPerspectiveMatrix( mat4 m ) {
	return m[ 2 ][ 3 ] == - 1.0;
}
vec2 equirectUv( in vec3 dir ) {
	float u = atan( dir.z, dir.x ) * RECIPROCAL_PI2 + 0.5;
	float v = asin( clamp( dir.y, - 1.0, 1.0 ) ) * RECIPROCAL_PI + 0.5;
	return vec2( u, v );
}
vec3 BRDF_Lambert( const in vec3 diffuseColor ) {
	return RECIPROCAL_PI * diffuseColor;
}
vec3 F_Schlick( const in vec3 f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
}
float F_Schlick( const in float f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
} // validated`,eM=`#ifdef ENVMAP_TYPE_CUBE_UV
	#define cubeUV_minMipLevel 4.0
	#define cubeUV_minTileSize 16.0
	float getFace( vec3 direction ) {
		vec3 absDirection = abs( direction );
		float face = - 1.0;
		if ( absDirection.x > absDirection.z ) {
			if ( absDirection.x > absDirection.y )
				face = direction.x > 0.0 ? 0.0 : 3.0;
			else
				face = direction.y > 0.0 ? 1.0 : 4.0;
		} else {
			if ( absDirection.z > absDirection.y )
				face = direction.z > 0.0 ? 2.0 : 5.0;
			else
				face = direction.y > 0.0 ? 1.0 : 4.0;
		}
		return face;
	}
	vec2 getUV( vec3 direction, float face ) {
		vec2 uv;
		if ( face == 0.0 ) {
			uv = vec2( direction.z, direction.y ) / abs( direction.x );
		} else if ( face == 1.0 ) {
			uv = vec2( - direction.x, - direction.z ) / abs( direction.y );
		} else if ( face == 2.0 ) {
			uv = vec2( - direction.x, direction.y ) / abs( direction.z );
		} else if ( face == 3.0 ) {
			uv = vec2( - direction.z, direction.y ) / abs( direction.x );
		} else if ( face == 4.0 ) {
			uv = vec2( - direction.x, direction.z ) / abs( direction.y );
		} else {
			uv = vec2( direction.x, direction.y ) / abs( direction.z );
		}
		return 0.5 * ( uv + 1.0 );
	}
	vec3 bilinearCubeUV( sampler2D envMap, vec3 direction, float mipInt ) {
		float face = getFace( direction );
		float filterInt = max( cubeUV_minMipLevel - mipInt, 0.0 );
		mipInt = max( mipInt, cubeUV_minMipLevel );
		float faceSize = exp2( mipInt );
		highp vec2 uv = getUV( direction, face ) * ( faceSize - 2.0 ) + 1.0;
		if ( face > 2.0 ) {
			uv.y += faceSize;
			face -= 3.0;
		}
		uv.x += face * faceSize;
		uv.x += filterInt * 3.0 * cubeUV_minTileSize;
		uv.y += 4.0 * ( exp2( CUBEUV_MAX_MIP ) - faceSize );
		uv.x *= CUBEUV_TEXEL_WIDTH;
		uv.y *= CUBEUV_TEXEL_HEIGHT;
		#ifdef texture2DGradEXT
			return texture2DGradEXT( envMap, uv, vec2( 0.0 ), vec2( 0.0 ) ).rgb;
		#else
			return texture2D( envMap, uv ).rgb;
		#endif
	}
	#define cubeUV_r0 1.0
	#define cubeUV_m0 - 2.0
	#define cubeUV_r1 0.8
	#define cubeUV_m1 - 1.0
	#define cubeUV_r4 0.4
	#define cubeUV_m4 2.0
	#define cubeUV_r5 0.305
	#define cubeUV_m5 3.0
	#define cubeUV_r6 0.21
	#define cubeUV_m6 4.0
	float roughnessToMip( float roughness ) {
		float mip = 0.0;
		if ( roughness >= cubeUV_r1 ) {
			mip = ( cubeUV_r0 - roughness ) * ( cubeUV_m1 - cubeUV_m0 ) / ( cubeUV_r0 - cubeUV_r1 ) + cubeUV_m0;
		} else if ( roughness >= cubeUV_r4 ) {
			mip = ( cubeUV_r1 - roughness ) * ( cubeUV_m4 - cubeUV_m1 ) / ( cubeUV_r1 - cubeUV_r4 ) + cubeUV_m1;
		} else if ( roughness >= cubeUV_r5 ) {
			mip = ( cubeUV_r4 - roughness ) * ( cubeUV_m5 - cubeUV_m4 ) / ( cubeUV_r4 - cubeUV_r5 ) + cubeUV_m4;
		} else if ( roughness >= cubeUV_r6 ) {
			mip = ( cubeUV_r5 - roughness ) * ( cubeUV_m6 - cubeUV_m5 ) / ( cubeUV_r5 - cubeUV_r6 ) + cubeUV_m5;
		} else {
			mip = - 2.0 * log2( 1.16 * roughness );		}
		return mip;
	}
	vec4 textureCubeUV( sampler2D envMap, vec3 sampleDir, float roughness ) {
		float mip = clamp( roughnessToMip( roughness ), cubeUV_m0, CUBEUV_MAX_MIP );
		float mipF = fract( mip );
		float mipInt = floor( mip );
		vec3 color0 = bilinearCubeUV( envMap, sampleDir, mipInt );
		if ( mipF == 0.0 ) {
			return vec4( color0, 1.0 );
		} else {
			vec3 color1 = bilinearCubeUV( envMap, sampleDir, mipInt + 1.0 );
			return vec4( mix( color0, color1, mipF ), 1.0 );
		}
	}
#endif`,tM=`vec3 transformedNormal = objectNormal;
#ifdef USE_TANGENT
	vec3 transformedTangent = objectTangent;
#endif
#ifdef USE_BATCHING
	mat3 bm = mat3( batchingMatrix );
	transformedNormal /= vec3( dot( bm[ 0 ], bm[ 0 ] ), dot( bm[ 1 ], bm[ 1 ] ), dot( bm[ 2 ], bm[ 2 ] ) );
	transformedNormal = bm * transformedNormal;
	#ifdef USE_TANGENT
		transformedTangent = bm * transformedTangent;
	#endif
#endif
#ifdef USE_INSTANCING
	mat3 im = mat3( instanceMatrix );
	transformedNormal /= vec3( dot( im[ 0 ], im[ 0 ] ), dot( im[ 1 ], im[ 1 ] ), dot( im[ 2 ], im[ 2 ] ) );
	transformedNormal = im * transformedNormal;
	#ifdef USE_TANGENT
		transformedTangent = im * transformedTangent;
	#endif
#endif
transformedNormal = normalMatrix * transformedNormal;
#ifdef FLIP_SIDED
	transformedNormal = - transformedNormal;
#endif
#ifdef USE_TANGENT
	transformedTangent = ( modelViewMatrix * vec4( transformedTangent, 0.0 ) ).xyz;
#endif`,nM=`#ifdef USE_DISPLACEMENTMAP
	uniform sampler2D displacementMap;
	uniform float displacementScale;
	uniform float displacementBias;
#endif`,iM=`#ifdef USE_DISPLACEMENTMAP
	transformed += normalize( objectNormal ) * ( texture2D( displacementMap, vDisplacementMapUv ).x * displacementScale + displacementBias );
#endif`,rM=`#ifdef USE_EMISSIVEMAP
	vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
	#ifdef DECODE_VIDEO_TEXTURE_EMISSIVE
		emissiveColor = sRGBTransferEOTF( emissiveColor );
	#endif
	totalEmissiveRadiance *= emissiveColor.rgb;
#endif`,sM=`#ifdef USE_EMISSIVEMAP
	uniform sampler2D emissiveMap;
#endif`,oM="gl_FragColor = linearToOutputTexel( gl_FragColor );",aM=`vec4 LinearTransferOETF( in vec4 value ) {
	return value;
}
vec4 sRGBTransferEOTF( in vec4 value ) {
	return vec4( mix( pow( value.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), value.rgb * 0.0773993808, vec3( lessThanEqual( value.rgb, vec3( 0.04045 ) ) ) ), value.a );
}
vec4 sRGBTransferOETF( in vec4 value ) {
	return vec4( mix( pow( value.rgb, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), value.rgb * 12.92, vec3( lessThanEqual( value.rgb, vec3( 0.0031308 ) ) ) ), value.a );
}`,lM=`#ifdef USE_ENVMAP
	#ifdef ENV_WORLDPOS
		vec3 cameraToFrag;
		if ( isOrthographic ) {
			cameraToFrag = normalize( vec3( - viewMatrix[ 0 ][ 2 ], - viewMatrix[ 1 ][ 2 ], - viewMatrix[ 2 ][ 2 ] ) );
		} else {
			cameraToFrag = normalize( vWorldPosition - cameraPosition );
		}
		vec3 worldNormal = transformNormalByInverseViewMatrix( normal, viewMatrix );
		#ifdef ENVMAP_MODE_REFLECTION
			vec3 reflectVec = reflect( cameraToFrag, worldNormal );
		#else
			vec3 reflectVec = refract( cameraToFrag, worldNormal, refractionRatio );
		#endif
	#else
		vec3 reflectVec = vReflect;
	#endif
	#ifdef ENVMAP_TYPE_CUBE
		vec4 envColor = textureCube( envMap, envMapRotation * reflectVec );
		#ifdef ENVMAP_BLENDING_MULTIPLY
			outgoingLight = mix( outgoingLight, outgoingLight * envColor.xyz, specularStrength * reflectivity );
		#elif defined( ENVMAP_BLENDING_MIX )
			outgoingLight = mix( outgoingLight, envColor.xyz, specularStrength * reflectivity );
		#elif defined( ENVMAP_BLENDING_ADD )
			outgoingLight += envColor.xyz * specularStrength * reflectivity;
		#endif
	#endif
#endif`,cM=`#ifdef USE_ENVMAP
	uniform float envMapIntensity;
	uniform mat3 envMapRotation;
	#ifdef ENVMAP_TYPE_CUBE
		uniform samplerCube envMap;
	#else
		uniform sampler2D envMap;
	#endif
#endif`,uM=`#ifdef USE_ENVMAP
	uniform float reflectivity;
	#if defined( USE_BUMPMAP ) || defined( USE_NORMALMAP ) || defined( PHONG ) || defined( LAMBERT )
		#define ENV_WORLDPOS
	#endif
	#ifdef ENV_WORLDPOS
		varying vec3 vWorldPosition;
		uniform float refractionRatio;
	#else
		varying vec3 vReflect;
	#endif
#endif`,hM=`#ifdef USE_ENVMAP
	#if defined( USE_BUMPMAP ) || defined( USE_NORMALMAP ) || defined( PHONG ) || defined( LAMBERT )
		#define ENV_WORLDPOS
	#endif
	#ifdef ENV_WORLDPOS
		
		varying vec3 vWorldPosition;
	#else
		varying vec3 vReflect;
		uniform float refractionRatio;
	#endif
#endif`,fM=`#ifdef USE_ENVMAP
	#ifdef ENV_WORLDPOS
		vWorldPosition = worldPosition.xyz;
	#else
		vec3 cameraToVertex;
		if ( isOrthographic ) {
			cameraToVertex = normalize( vec3( - viewMatrix[ 0 ][ 2 ], - viewMatrix[ 1 ][ 2 ], - viewMatrix[ 2 ][ 2 ] ) );
		} else {
			cameraToVertex = normalize( worldPosition.xyz - cameraPosition );
		}
		vec3 worldNormal = transformNormalByInverseViewMatrix( transformedNormal, viewMatrix );
		#ifdef ENVMAP_MODE_REFLECTION
			vReflect = reflect( cameraToVertex, worldNormal );
		#else
			vReflect = refract( cameraToVertex, worldNormal, refractionRatio );
		#endif
	#endif
#endif`,dM=`#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
#endif`,pM=`#ifdef USE_FOG
	varying float vFogDepth;
#endif`,mM=`#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`,gM=`#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`,vM=`#ifdef USE_GRADIENTMAP
	uniform sampler2D gradientMap;
#endif
vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
	float dotNL = dot( normal, lightDirection );
	vec2 coord = vec2( dotNL * 0.5 + 0.5, 0.0 );
	#ifdef USE_GRADIENTMAP
		return vec3( texture2D( gradientMap, coord ).r );
	#else
		vec2 fw = fwidth( coord ) * 0.5;
		return mix( vec3( 0.7 ), vec3( 1.0 ), smoothstep( 0.7 - fw.x, 0.7 + fw.x, coord.x ) );
	#endif
}`,xM=`#ifdef USE_LIGHTMAP
	uniform sampler2D lightMap;
	uniform float lightMapIntensity;
#endif`,yM=`LambertMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.specularStrength = specularStrength;`,_M=`varying vec3 vViewPosition;
struct LambertMaterial {
	vec3 diffuseColor;
	float specularStrength;
};
void RE_Direct_Lambert( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_Lambert
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Lambert`,MM=`uniform bool receiveShadow;
uniform vec3 ambientLightColor;
#if defined( USE_LIGHT_PROBES )
	uniform vec3 lightProbe[ 9 ];
#endif
vec3 shGetIrradianceAt( in vec3 normal, in vec3 shCoefficients[ 9 ] ) {
	float x = normal.x, y = normal.y, z = normal.z;
	vec3 result = shCoefficients[ 0 ] * 0.886227;
	result += shCoefficients[ 1 ] * 2.0 * 0.511664 * y;
	result += shCoefficients[ 2 ] * 2.0 * 0.511664 * z;
	result += shCoefficients[ 3 ] * 2.0 * 0.511664 * x;
	result += shCoefficients[ 4 ] * 2.0 * 0.429043 * x * y;
	result += shCoefficients[ 5 ] * 2.0 * 0.429043 * y * z;
	result += shCoefficients[ 6 ] * ( 0.743125 * z * z - 0.247708 );
	result += shCoefficients[ 7 ] * 2.0 * 0.429043 * x * z;
	result += shCoefficients[ 8 ] * 0.429043 * ( x * x - y * y );
	return result;
}
vec3 getLightProbeIrradiance( const in vec3 lightProbe[ 9 ], const in vec3 normal ) {
	vec3 worldNormal = transformNormalByInverseViewMatrix( normal, viewMatrix );
	vec3 irradiance = shGetIrradianceAt( worldNormal, lightProbe );
	return irradiance;
}
vec3 getAmbientLightIrradiance( const in vec3 ambientLightColor ) {
	vec3 irradiance = ambientLightColor;
	return irradiance;
}
float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {
	float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );
	if ( cutoffDistance > 0.0 ) {
		distanceFalloff *= pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) );
	}
	return distanceFalloff;
}
float getSpotAttenuation( const in float coneCosine, const in float penumbraCosine, const in float angleCosine ) {
	return smoothstep( coneCosine, penumbraCosine, angleCosine );
}
#if NUM_SUN_LIGHTS > 0
	struct SunLight {
		vec3 direction;
		vec3 color;
	};
	uniform SunLight sunLights[ NUM_SUN_LIGHTS ];
	void getSunLightInfo( const in SunLight sunLight, out IncidentLight light ) {
		light.color = sunLight.color;
		light.direction = sunLight.direction;
		light.visible = true;
	}
#endif
#if NUM_DIR_LIGHTS > 0
	struct DirectionalLight {
		vec3 direction;
		vec3 color;
	};
	uniform DirectionalLight directionalLights[ NUM_DIR_LIGHTS ];
	void getDirectionalLightInfo( const in DirectionalLight directionalLight, out IncidentLight light ) {
		light.color = directionalLight.color;
		light.direction = directionalLight.direction;
		light.visible = true;
	}
#endif
#if NUM_POINT_LIGHTS > 0
	struct PointLight {
		vec3 position;
		vec3 color;
		float distance;
		float decay;
	};
	uniform PointLight pointLights[ NUM_POINT_LIGHTS ];
	void getPointLightInfo( const in PointLight pointLight, const in vec3 geometryPosition, out IncidentLight light ) {
		vec3 lVector = pointLight.position - geometryPosition;
		light.direction = normalize( lVector );
		float lightDistance = length( lVector );
		light.color = pointLight.color;
		light.color *= getDistanceAttenuation( lightDistance, pointLight.distance, pointLight.decay );
		light.visible = ( light.color != vec3( 0.0 ) );
	}
#endif
#if NUM_SPOT_LIGHTS > 0
	struct SpotLight {
		vec3 position;
		vec3 direction;
		vec3 color;
		float distance;
		float decay;
		float coneCos;
		float penumbraCos;
	};
	uniform SpotLight spotLights[ NUM_SPOT_LIGHTS ];
	void getSpotLightInfo( const in SpotLight spotLight, const in vec3 geometryPosition, out IncidentLight light ) {
		vec3 lVector = spotLight.position - geometryPosition;
		light.direction = normalize( lVector );
		float angleCos = dot( light.direction, spotLight.direction );
		float spotAttenuation = getSpotAttenuation( spotLight.coneCos, spotLight.penumbraCos, angleCos );
		if ( spotAttenuation > 0.0 ) {
			float lightDistance = length( lVector );
			light.color = spotLight.color * spotAttenuation;
			light.color *= getDistanceAttenuation( lightDistance, spotLight.distance, spotLight.decay );
			light.visible = ( light.color != vec3( 0.0 ) );
		} else {
			light.color = vec3( 0.0 );
			light.visible = false;
		}
	}
#endif
#if NUM_RECT_AREA_LIGHTS > 0
	struct RectAreaLight {
		vec3 color;
		vec3 position;
		vec3 halfWidth;
		vec3 halfHeight;
	};
	uniform sampler2D ltc_1;	uniform sampler2D ltc_2;
	uniform RectAreaLight rectAreaLights[ NUM_RECT_AREA_LIGHTS ];
#endif
#if NUM_HEMI_LIGHTS > 0
	struct HemisphereLight {
		vec3 direction;
		vec3 skyColor;
		vec3 groundColor;
	};
	uniform HemisphereLight hemisphereLights[ NUM_HEMI_LIGHTS ];
	vec3 getHemisphereLightIrradiance( const in HemisphereLight hemiLight, const in vec3 normal ) {
		float dotNL = dot( normal, hemiLight.direction );
		float hemiDiffuseWeight = 0.5 * dotNL + 0.5;
		vec3 irradiance = mix( hemiLight.groundColor, hemiLight.skyColor, hemiDiffuseWeight );
		return irradiance;
	}
#endif
#include <lightprobes_pars_fragment>`,SM=`#ifdef USE_ENVMAP
	vec3 getIBLIrradiance( const in vec3 normal ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 worldNormal = transformNormalByInverseViewMatrix( normal, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, envMapRotation * worldNormal, 1.0 );
			return PI * envMapColor.rgb * envMapIntensity;
		#else
			return vec3( 0.0 );
		#endif
	}
	vec3 getIBLRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 reflectVec = reflect( - viewDir, normal );
			reflectVec = normalize( mix( reflectVec, normal, pow4( roughness ) ) );
			reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );
			return envMapColor.rgb * envMapIntensity;
		#else
			return vec3( 0.0 );
		#endif
	}
	#ifdef USE_RETROREFLECTION
		vec3 getIBLRetroRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
			#ifdef ENVMAP_TYPE_CUBE_UV
				vec3 retroVec = normalize( mix( viewDir, normal, pow4( roughness ) ) );
				retroVec = transformDirectionByInverseViewMatrix( retroVec, viewMatrix );
				vec4 envMapColor = textureCubeUV( envMap, envMapRotation * retroVec, roughness );
				return envMapColor.rgb * envMapIntensity;
			#else
				return vec3( 0.0 );
			#endif
		}
	#endif
	#ifdef USE_ANISOTROPY
		vec3 getIBLAnisotropyRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in vec3 bitangent, const in float anisotropy ) {
			#ifdef ENVMAP_TYPE_CUBE_UV
				vec3 bentNormal = cross( bitangent, viewDir );
				bentNormal = normalize( cross( bentNormal, bitangent ) );
				bentNormal = normalize( mix( bentNormal, normal, pow2( pow2( 1.0 - anisotropy * ( 1.0 - roughness ) ) ) ) );
				return getIBLRadiance( viewDir, bentNormal, roughness );
			#else
				return vec3( 0.0 );
			#endif
		}
		#ifdef USE_RETROREFLECTION
			vec3 getIBLAnisotropyRetroRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in vec3 bitangent, const in float anisotropy ) {
				#ifdef ENVMAP_TYPE_CUBE_UV
					vec3 bentNormal = cross( bitangent, viewDir );
					bentNormal = normalize( cross( bentNormal, bitangent ) );
					bentNormal = normalize( mix( bentNormal, normal, pow2( pow2( 1.0 - anisotropy * ( 1.0 - roughness ) ) ) ) );
					return getIBLRetroRadiance( viewDir, bentNormal, roughness );
				#else
					return vec3( 0.0 );
				#endif
			}
		#endif
	#endif
#endif`,bM=`ToonMaterial material;
material.diffuseColor = diffuseColor.rgb;`,wM=`varying vec3 vViewPosition;
struct ToonMaterial {
	vec3 diffuseColor;
};
void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_Toon
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Toon`,TM=`BlinnPhongMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.specularColor = specular;
material.specularShininess = shininess;
material.specularStrength = specularStrength;`,AM=`varying vec3 vViewPosition;
struct BlinnPhongMaterial {
	vec3 diffuseColor;
	vec3 specularColor;
	float specularShininess;
	float specularStrength;
};
void RE_Direct_BlinnPhong( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
	reflectedLight.directSpecular += irradiance * BRDF_BlinnPhong( directLight.direction, geometryViewDir, geometryNormal, material.specularColor, material.specularShininess ) * material.specularStrength;
}
void RE_IndirectDiffuse_BlinnPhong( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_BlinnPhong
#define RE_IndirectDiffuse		RE_IndirectDiffuse_BlinnPhong`,EM=`PhysicalMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.diffuseContribution = diffuseColor.rgb * ( 1.0 - metalnessFactor );
material.metalness = metalnessFactor;
vec3 dxy = max( abs( dFdx( nonPerturbedNormal ) ), abs( dFdy( nonPerturbedNormal ) ) );
float geometryRoughness = max( max( dxy.x, dxy.y ), dxy.z );
material.roughness = max( roughnessFactor, 0.0525 );material.roughness += geometryRoughness;
material.roughness = min( material.roughness, 1.0 );
#ifdef IOR
	material.ior = ior;
	#ifdef USE_SPECULAR
		float specularIntensityFactor = specularIntensity;
		vec3 specularColorFactor = specularColor;
		#ifdef USE_SPECULAR_COLORMAP
			specularColorFactor *= texture2D( specularColorMap, vSpecularColorMapUv ).rgb;
		#endif
		#ifdef USE_SPECULAR_INTENSITYMAP
			specularIntensityFactor *= texture2D( specularIntensityMap, vSpecularIntensityMapUv ).a;
		#endif
		material.specularF90 = mix( specularIntensityFactor, 1.0, metalnessFactor );
	#else
		float specularIntensityFactor = 1.0;
		vec3 specularColorFactor = vec3( 1.0 );
		material.specularF90 = 1.0;
	#endif
	material.specularColor = min( pow2( ( material.ior - 1.0 ) / ( material.ior + 1.0 ) ) * specularColorFactor, vec3( 1.0 ) ) * specularIntensityFactor;
	material.specularColorBlended = mix( material.specularColor, diffuseColor.rgb, metalnessFactor );
#else
	material.specularColor = vec3( 0.04 );
	material.specularColorBlended = mix( material.specularColor, diffuseColor.rgb, metalnessFactor );
	material.specularF90 = 1.0;
#endif
#ifdef USE_CLEARCOAT
	material.clearcoat = clearcoat;
	material.clearcoatRoughness = clearcoatRoughness;
	material.clearcoatF0 = vec3( 0.04 );
	material.clearcoatF90 = 1.0;
	#ifdef USE_CLEARCOATMAP
		material.clearcoat *= texture2D( clearcoatMap, vClearcoatMapUv ).x;
	#endif
	#ifdef USE_CLEARCOAT_ROUGHNESSMAP
		material.clearcoatRoughness *= texture2D( clearcoatRoughnessMap, vClearcoatRoughnessMapUv ).y;
	#endif
	material.clearcoat = saturate( material.clearcoat );	material.clearcoatRoughness = max( material.clearcoatRoughness, 0.0525 );
	material.clearcoatRoughness += geometryRoughness;
	material.clearcoatRoughness = min( material.clearcoatRoughness, 1.0 );
#endif
#ifdef USE_DISPERSION
	material.dispersion = dispersion;
#endif
#ifdef USE_RETROREFLECTION
	material.retroreflectivity = retroreflectivity;
#endif
#ifdef USE_IRIDESCENCE
	material.iridescence = iridescence;
	material.iridescenceIOR = iridescenceIOR;
	#ifdef USE_IRIDESCENCEMAP
		material.iridescence *= texture2D( iridescenceMap, vIridescenceMapUv ).r;
	#endif
	#ifdef USE_IRIDESCENCE_THICKNESSMAP
		material.iridescenceThickness = (iridescenceThicknessMaximum - iridescenceThicknessMinimum) * texture2D( iridescenceThicknessMap, vIridescenceThicknessMapUv ).g + iridescenceThicknessMinimum;
	#else
		material.iridescenceThickness = iridescenceThicknessMaximum;
	#endif
#endif
#ifdef USE_SHEEN
	material.sheenColor = sheenColor;
	#ifdef USE_SHEEN_COLORMAP
		material.sheenColor *= texture2D( sheenColorMap, vSheenColorMapUv ).rgb;
	#endif
	material.sheenRoughness = clamp( sheenRoughness, 0.0001, 1.0 );
	#ifdef USE_SHEEN_ROUGHNESSMAP
		material.sheenRoughness *= texture2D( sheenRoughnessMap, vSheenRoughnessMapUv ).a;
	#endif
#endif
#ifdef USE_ANISOTROPY
	#ifdef USE_ANISOTROPYMAP
		mat2 anisotropyMat = mat2( anisotropyVector.x, anisotropyVector.y, - anisotropyVector.y, anisotropyVector.x );
		vec3 anisotropyPolar = texture2D( anisotropyMap, vAnisotropyMapUv ).rgb;
		vec2 anisotropyV = anisotropyMat * normalize( 2.0 * anisotropyPolar.rg - vec2( 1.0 ) ) * anisotropyPolar.b;
	#else
		vec2 anisotropyV = anisotropyVector;
	#endif
	material.anisotropy = length( anisotropyV );
	if( material.anisotropy == 0.0 ) {
		anisotropyV = vec2( 1.0, 0.0 );
	} else {
		anisotropyV /= material.anisotropy;
		material.anisotropy = saturate( material.anisotropy );
	}
	material.alphaT = mix( pow2( material.roughness ), 1.0, pow2( material.anisotropy ) );
	material.anisotropyT = tbn[ 0 ] * anisotropyV.x + tbn[ 1 ] * anisotropyV.y;
	material.anisotropyB = tbn[ 1 ] * anisotropyV.x - tbn[ 0 ] * anisotropyV.y;
#endif`,CM=`uniform sampler2D dfgLUT;
struct PhysicalMaterial {
	vec3 diffuseColor;
	vec3 diffuseContribution;
	vec3 specularColor;
	vec3 specularColorBlended;
	float roughness;
	float metalness;
	float specularF90;
	float dispersion;
	vec2 dfg;
	vec3 multiScatteringCompensation;
	#ifdef USE_RETROREFLECTION
		float retroreflectivity;
	#endif
	#ifdef USE_CLEARCOAT
		float clearcoat;
		float clearcoatRoughness;
		vec3 clearcoatF0;
		float clearcoatF90;
	#endif
	#ifdef USE_IRIDESCENCE
		float iridescence;
		float iridescenceIOR;
		float iridescenceThickness;
		vec3 iridescenceFresnel;
		vec3 iridescenceF0Dielectric;
		vec3 iridescenceF0Metallic;
	#endif
	#ifdef USE_SHEEN
		vec3 sheenColor;
		float sheenRoughness;
	#endif
	#ifdef IOR
		float ior;
	#endif
	#ifdef USE_TRANSMISSION
		float transmission;
		float transmissionAlpha;
		float thickness;
		float attenuationDistance;
		vec3 attenuationColor;
	#endif
	#ifdef USE_ANISOTROPY
		float anisotropy;
		float alphaT;
		vec3 anisotropyT;
		vec3 anisotropyB;
	#endif
};
vec3 clearcoatSpecularDirect = vec3( 0.0 );
vec3 clearcoatSpecularIndirect = vec3( 0.0 );
vec3 sheenSpecularDirect = vec3( 0.0 );
vec3 sheenSpecularIndirect = vec3(0.0 );
vec3 Schlick_to_F0( const in vec3 f, const in float f90, const in float dotVH ) {
    float x = clamp( 1.0 - dotVH, 0.0, 1.0 );
    float x2 = x * x;
    float x5 = clamp( x * x2 * x2, 0.0, 0.9999 );
    return ( f - vec3( f90 ) * x5 ) / ( 1.0 - x5 );
}
float V_GGX_SmithCorrelated( const in float alpha, const in float dotNL, const in float dotNV ) {
	float a2 = pow2( alpha );
	float gv = dotNL * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNV ) );
	float gl = dotNV * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNL ) );
	return 0.5 / max( gv + gl, EPSILON );
}
float D_GGX( const in float alpha, const in float dotNH ) {
	float a2 = pow2( alpha );
	float denom = pow2( dotNH ) * ( a2 - 1.0 ) + 1.0;
	return RECIPROCAL_PI * a2 / pow2( denom );
}
#ifdef USE_ANISOTROPY
	float V_GGX_SmithCorrelated_Anisotropic( const in float alphaT, const in float alphaB, const in float dotTV, const in float dotBV, const in float dotTL, const in float dotBL, const in float dotNV, const in float dotNL ) {
		float gv = dotNL * length( vec3( alphaT * dotTV, alphaB * dotBV, dotNV ) );
		float gl = dotNV * length( vec3( alphaT * dotTL, alphaB * dotBL, dotNL ) );
		return 0.5 / max( gv + gl, EPSILON );
	}
	float D_GGX_Anisotropic( const in float alphaT, const in float alphaB, const in float dotNH, const in float dotTH, const in float dotBH ) {
		float a2 = alphaT * alphaB;
		highp vec3 v = vec3( alphaB * dotTH, alphaT * dotBH, a2 * dotNH );
		highp float v2 = dot( v, v );
		float w2 = a2 / v2;
		return RECIPROCAL_PI * a2 * pow2 ( w2 );
	}
#endif
#ifdef USE_CLEARCOAT
	vec3 BRDF_GGX_Clearcoat( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material) {
		vec3 f0 = material.clearcoatF0;
		float f90 = material.clearcoatF90;
		float roughness = material.clearcoatRoughness;
		float alpha = pow2( roughness );
		vec3 halfDir = normalize( lightDir + viewDir );
		float dotNL = saturate( dot( normal, lightDir ) );
		float dotNV = saturate( dot( normal, viewDir ) );
		float dotNH = saturate( dot( normal, halfDir ) );
		float dotVH = saturate( dot( viewDir, halfDir ) );
		vec3 F = F_Schlick( f0, f90, dotVH );
		float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
		float D = D_GGX( alpha, dotNH );
		return F * ( V * D );
	}
#endif
vec3 BRDF_GGX( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material ) {
	vec3 f0 = material.specularColorBlended;
	float f90 = material.specularF90;
	float roughness = material.roughness;
	float alpha = pow2( roughness );
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( f0, f90, dotVH );
	#ifdef USE_IRIDESCENCE
		F = mix( F, material.iridescenceFresnel, material.iridescence );
	#endif
	#ifdef USE_ANISOTROPY
		float dotTL = dot( material.anisotropyT, lightDir );
		float dotTV = dot( material.anisotropyT, viewDir );
		float dotTH = dot( material.anisotropyT, halfDir );
		float dotBL = dot( material.anisotropyB, lightDir );
		float dotBV = dot( material.anisotropyB, viewDir );
		float dotBH = dot( material.anisotropyB, halfDir );
		float V = V_GGX_SmithCorrelated_Anisotropic( material.alphaT, alpha, dotTV, dotBV, dotTL, dotBL, dotNV, dotNL );
		float D = D_GGX_Anisotropic( material.alphaT, alpha, dotNH, dotTH, dotBH );
	#else
		float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
		float D = D_GGX( alpha, dotNH );
	#endif
	return F * ( V * D );
}
vec2 LTC_Uv( const in vec3 N, const in vec3 V, const in float roughness ) {
	const float LUT_SIZE = 64.0;
	const float LUT_SCALE = ( LUT_SIZE - 1.0 ) / LUT_SIZE;
	const float LUT_BIAS = 0.5 / LUT_SIZE;
	float dotNV = saturate( dot( N, V ) );
	vec2 uv = vec2( roughness, sqrt( 1.0 - dotNV ) );
	uv = uv * LUT_SCALE + LUT_BIAS;
	return uv;
}
float LTC_ClippedSphereFormFactor( const in vec3 f ) {
	float l = length( f );
	return max( ( l * l + f.z ) / ( l + 1.0 ), 0.0 );
}
vec3 LTC_EdgeVectorFormFactor( const in vec3 v1, const in vec3 v2 ) {
	float x = dot( v1, v2 );
	float y = abs( x );
	float a = 0.8543985 + ( 0.4965155 + 0.0145206 * y ) * y;
	float b = 3.4175940 + ( 4.1616724 + y ) * y;
	float v = a / b;
	float theta_sintheta = ( x > 0.0 ) ? v : 0.5 * inversesqrt( max( 1.0 - x * x, 1e-7 ) ) - v;
	return cross( v1, v2 ) * theta_sintheta;
}
vec3 LTC_Evaluate( const in vec3 N, const in vec3 V, const in vec3 P, const in mat3 mInv, const in vec3 rectCoords[ 4 ] ) {
	vec3 v1 = rectCoords[ 1 ] - rectCoords[ 0 ];
	vec3 v2 = rectCoords[ 3 ] - rectCoords[ 0 ];
	vec3 lightNormal = cross( v1, v2 );
	if( dot( lightNormal, P - rectCoords[ 0 ] ) < 0.0 ) return vec3( 0.0 );
	vec3 T1, T2;
	T1 = normalize( V - N * dot( V, N ) );
	T2 = - cross( N, T1 );
	mat3 mat = mInv * transpose( mat3( T1, T2, N ) );
	vec3 coords[ 4 ];
	coords[ 0 ] = mat * ( rectCoords[ 0 ] - P );
	coords[ 1 ] = mat * ( rectCoords[ 1 ] - P );
	coords[ 2 ] = mat * ( rectCoords[ 2 ] - P );
	coords[ 3 ] = mat * ( rectCoords[ 3 ] - P );
	coords[ 0 ] = normalize( coords[ 0 ] );
	coords[ 1 ] = normalize( coords[ 1 ] );
	coords[ 2 ] = normalize( coords[ 2 ] );
	coords[ 3 ] = normalize( coords[ 3 ] );
	vec3 vectorFormFactor = vec3( 0.0 );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 0 ], coords[ 1 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 1 ], coords[ 2 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 2 ], coords[ 3 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 3 ], coords[ 0 ] );
	float result = LTC_ClippedSphereFormFactor( vectorFormFactor );
	return vec3( result );
}
#if defined( USE_SHEEN )
float D_Charlie( float roughness, float dotNH ) {
	float alpha = pow2( roughness );
	float invAlpha = 1.0 / alpha;
	float cos2h = dotNH * dotNH;
	float sin2h = max( 1.0 - cos2h, 0.0078125 );
	return ( 2.0 + invAlpha ) * pow( sin2h, invAlpha * 0.5 ) / ( 2.0 * PI );
}
float V_Neubelt( float dotNV, float dotNL ) {
	return saturate( 1.0 / ( 4.0 * ( dotNL + dotNV - dotNL * dotNV ) ) );
}
vec3 BRDF_Sheen( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, vec3 sheenColor, const in float sheenRoughness ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float D = D_Charlie( sheenRoughness, dotNH );
	float V = V_Neubelt( dotNV, dotNL );
	return sheenColor * ( D * V );
}
#endif
float IBLSheenBRDF( const in vec3 normal, const in vec3 viewDir, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	float r2 = roughness * roughness;
	float rInv = 1.0 / ( roughness + 0.1 );
	float a = -1.9362 + 1.0678 * roughness + 0.4573 * r2 - 0.8469 * rInv;
	float b = -0.6014 + 0.5538 * roughness - 0.4670 * r2 - 0.1255 * rInv;
	float DG = exp( a * dotNV + b );
	return saturate( DG );
}
vec3 EnvironmentBRDF( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	vec2 fab = texture2D( dfgLUT, vec2( roughness, dotNV ) ).rg;
	return specularColor * fab.x + specularF90 * fab.y;
}
#ifdef USE_IRIDESCENCE
void computeMultiscatteringIridescence( const in vec2 fab, const in vec3 specularColor, const in float specularF90, const in float iridescence, const in vec3 iridescenceF0, inout vec3 singleScatter, inout vec3 multiScatter ) {
#else
void computeMultiscattering( const in vec2 fab, const in vec3 specularColor, const in float specularF90, inout vec3 singleScatter, inout vec3 multiScatter ) {
#endif
	#ifdef USE_IRIDESCENCE
		vec3 Fr = mix( specularColor, iridescenceF0, iridescence );
	#else
		vec3 Fr = specularColor;
	#endif
	vec3 FssEss = Fr * fab.x + specularF90 * fab.y;
	float Ess = fab.x + fab.y;
	float Ems = 1.0 - Ess;
	vec3 Favg = Fr + ( 1.0 - Fr ) * 0.047619;	vec3 Fms = FssEss * Favg / ( 1.0 - Ems * Favg );
	singleScatter += FssEss;
	multiScatter += Fms * Ems;
}
#if NUM_RECT_AREA_LIGHTS > 0
	void RE_Direct_RectArea_Physical( const in RectAreaLight rectAreaLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
		vec3 normal = geometryNormal;
		vec3 viewDir = geometryViewDir;
		vec3 position = geometryPosition;
		vec3 lightPos = rectAreaLight.position;
		vec3 halfWidth = rectAreaLight.halfWidth;
		vec3 halfHeight = rectAreaLight.halfHeight;
		vec3 lightColor = rectAreaLight.color;
		float roughness = material.roughness;
		vec3 rectCoords[ 4 ];
		rectCoords[ 0 ] = lightPos + halfWidth - halfHeight;		rectCoords[ 1 ] = lightPos - halfWidth - halfHeight;
		rectCoords[ 2 ] = lightPos - halfWidth + halfHeight;
		rectCoords[ 3 ] = lightPos + halfWidth + halfHeight;
		vec2 uv = LTC_Uv( normal, viewDir, roughness );
		vec4 t1 = texture2D( ltc_1, uv );
		vec4 t2 = texture2D( ltc_2, uv );
		mat3 mInv = mat3(
			vec3( t1.x, 0, t1.y ),
			vec3(    0, 1,    0 ),
			vec3( t1.z, 0, t1.w )
		);
		vec3 fresnel = ( material.specularColorBlended * t2.x + ( material.specularF90 - material.specularColorBlended ) * t2.y );
		reflectedLight.directSpecular += lightColor * fresnel * LTC_Evaluate( normal, viewDir, position, mInv, rectCoords );
		reflectedLight.directDiffuse += lightColor * material.diffuseContribution * LTC_Evaluate( normal, viewDir, position, mat3( 1.0 ), rectCoords );
		#ifdef USE_CLEARCOAT
			vec3 Ncc = geometryClearcoatNormal;
			vec2 uvClearcoat = LTC_Uv( Ncc, viewDir, material.clearcoatRoughness );
			vec4 t1Clearcoat = texture2D( ltc_1, uvClearcoat );
			vec4 t2Clearcoat = texture2D( ltc_2, uvClearcoat );
			mat3 mInvClearcoat = mat3(
				vec3( t1Clearcoat.x, 0, t1Clearcoat.y ),
				vec3(             0, 1,             0 ),
				vec3( t1Clearcoat.z, 0, t1Clearcoat.w )
			);
			vec3 fresnelClearcoat = material.clearcoatF0 * t2Clearcoat.x + ( material.clearcoatF90 - material.clearcoatF0 ) * t2Clearcoat.y;
			clearcoatSpecularDirect += lightColor * fresnelClearcoat * LTC_Evaluate( Ncc, viewDir, position, mInvClearcoat, rectCoords );
		#endif
	}
#endif
void RE_Direct_Physical( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	#ifdef USE_CLEARCOAT
		float dotNLcc = saturate( dot( geometryClearcoatNormal, directLight.direction ) );
		vec3 ccIrradiance = dotNLcc * directLight.color;
		clearcoatSpecularDirect += ccIrradiance * BRDF_GGX_Clearcoat( directLight.direction, geometryViewDir, geometryClearcoatNormal, material );
	#endif
	#ifdef USE_SHEEN
 
 		sheenSpecularDirect += irradiance * BRDF_Sheen( directLight.direction, geometryViewDir, geometryNormal, material.sheenColor, material.sheenRoughness );
 
 		float sheenAlbedoV = IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness );
 		float sheenAlbedoL = IBLSheenBRDF( geometryNormal, directLight.direction, material.sheenRoughness );
 
 		float sheenEnergyComp = 1.0 - max3( material.sheenColor ) * max( sheenAlbedoV, sheenAlbedoL );
 
 		irradiance *= sheenEnergyComp;
 
 	#endif
	vec3 specularBRDF = BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );
	#ifdef USE_RETROREFLECTION
		vec3 retroViewDir = reflect( - geometryViewDir, geometryNormal );
		vec3 retroSpecularBRDF = BRDF_GGX( directLight.direction, retroViewDir, geometryNormal, material );
		specularBRDF = mix( specularBRDF, retroSpecularBRDF, saturate( material.retroreflectivity ) );
	#endif
	reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;
	vec3 halfDir = normalize( directLight.direction + geometryViewDir );
	float dotVH = saturate( dot( geometryViewDir, halfDir ) );
	vec3 F = F_Schlick( material.specularColor, material.specularF90, dotVH );
	#ifdef USE_RETROREFLECTION
		vec3 retroHalfDir = normalize( directLight.direction + retroViewDir );
		float dotRetroVH = saturate( dot( retroViewDir, retroHalfDir ) );
		vec3 retroF = F_Schlick( material.specularColor, material.specularF90, dotRetroVH );
		F = mix( F, retroF, saturate( material.retroreflectivity ) );
	#endif
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
}
void RE_IndirectDiffuse_Physical( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	vec3 singleScattering = vec3( 0.0 );
	vec3 multiScattering = vec3( 0.0 );
	#ifdef USE_IRIDESCENCE
		computeMultiscatteringIridescence( material.dfg, material.specularColor, material.specularF90, material.iridescence, material.iridescenceF0Dielectric, singleScattering, multiScattering );
	#else
		computeMultiscattering( material.dfg, material.specularColor, material.specularF90, singleScattering, multiScattering );
	#endif
	vec3 diffuse = irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - singleScattering - multiScattering );
	#ifdef USE_SHEEN
		float sheenAlbedo = IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness );
		sheenSpecularIndirect += irradiance * material.sheenColor * sheenAlbedo * RECIPROCAL_PI;
		float sheenEnergyComp = 1.0 - max3( material.sheenColor ) * sheenAlbedo;
		diffuse *= sheenEnergyComp;
	#endif
	reflectedLight.indirectDiffuse += diffuse;
}
void RE_IndirectSpecular_Physical( const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
	#ifdef USE_CLEARCOAT
		clearcoatSpecularIndirect += clearcoatRadiance * EnvironmentBRDF( geometryClearcoatNormal, geometryViewDir, material.clearcoatF0, material.clearcoatF90, material.clearcoatRoughness );
	#endif
	#ifdef USE_SHEEN
		sheenSpecularIndirect += irradiance * material.sheenColor * IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness ) * RECIPROCAL_PI;
 	#endif
	vec3 singleScatteringDielectric = vec3( 0.0 );
	vec3 multiScatteringDielectric = vec3( 0.0 );
	vec3 singleScatteringMetallic = vec3( 0.0 );
	vec3 multiScatteringMetallic = vec3( 0.0 );
	#ifdef USE_IRIDESCENCE
		computeMultiscatteringIridescence( material.dfg, material.specularColor, material.specularF90, material.iridescence, material.iridescenceF0Dielectric, singleScatteringDielectric, multiScatteringDielectric );
		computeMultiscatteringIridescence( material.dfg, material.diffuseColor, material.specularF90, material.iridescence, material.iridescenceF0Metallic, singleScatteringMetallic, multiScatteringMetallic );
	#else
		computeMultiscattering( material.dfg, material.specularColor, material.specularF90, singleScatteringDielectric, multiScatteringDielectric );
		computeMultiscattering( material.dfg, material.diffuseColor, material.specularF90, singleScatteringMetallic, multiScatteringMetallic );
	#endif
	vec3 singleScattering = mix( singleScatteringDielectric, singleScatteringMetallic, material.metalness );
	vec3 multiScattering = mix( multiScatteringDielectric, multiScatteringMetallic, material.metalness );
	vec3 totalScatteringDielectric = singleScatteringDielectric + multiScatteringDielectric;
	vec3 diffuse = material.diffuseContribution * ( 1.0 - totalScatteringDielectric );
	vec3 cosineWeightedIrradiance = irradiance * RECIPROCAL_PI;
	vec3 indirectSpecular = radiance * singleScattering;
	indirectSpecular += multiScattering * cosineWeightedIrradiance;
	vec3 indirectDiffuse = diffuse * cosineWeightedIrradiance;
	#ifdef USE_SHEEN
		float sheenAlbedo = IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness );
		float sheenEnergyComp = 1.0 - max3( material.sheenColor ) * sheenAlbedo;
		indirectSpecular *= sheenEnergyComp;
		indirectDiffuse *= sheenEnergyComp;
	#endif
	reflectedLight.indirectSpecular += indirectSpecular;
	reflectedLight.indirectDiffuse += indirectDiffuse;
}
#define RE_Direct				RE_Direct_Physical
#define RE_Direct_RectArea		RE_Direct_RectArea_Physical
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Physical
#define RE_IndirectSpecular		RE_IndirectSpecular_Physical
float computeSpecularOcclusion( const in float dotNV, const in float ambientOcclusion, const in float roughness ) {
	return saturate( pow( dotNV + ambientOcclusion, exp2( - 16.0 * roughness - 1.0 ) ) - 1.0 + ambientOcclusion );
}`,RM=`
vec3 geometryPosition = - vViewPosition;
vec3 geometryNormal = normal;
vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );
vec3 geometryClearcoatNormal = vec3( 0.0 );
#ifdef USE_CLEARCOAT
	geometryClearcoatNormal = clearcoatNormal;
#endif
#ifdef USE_IRIDESCENCE
	float dotNVi = saturate( dot( normal, geometryViewDir ) );
	if ( material.iridescenceThickness == 0.0 ) {
		material.iridescence = 0.0;
	} else {
		material.iridescence = saturate( material.iridescence );
	}
	if ( material.iridescence > 0.0 ) {
		vec3 iridescenceFresnelDielectric = evalIridescence( 1.0, material.iridescenceIOR, dotNVi, material.iridescenceThickness, material.specularColor );
		vec3 iridescenceFresnelMetallic = evalIridescence( 1.0, material.iridescenceIOR, dotNVi, material.iridescenceThickness, material.diffuseColor );
		material.iridescenceFresnel = mix( iridescenceFresnelDielectric, iridescenceFresnelMetallic, material.metalness );
		material.iridescenceF0Dielectric = Schlick_to_F0( iridescenceFresnelDielectric, 1.0, dotNVi );
		material.iridescenceF0Metallic = Schlick_to_F0( iridescenceFresnelMetallic, 1.0, dotNVi );
	}
#endif
#ifdef STANDARD
	float dotNVms = saturate( dot( geometryNormal, geometryViewDir ) );
	material.dfg = texture2D( dfgLUT, vec2( material.roughness, dotNVms ) ).rg;
	#if ( NUM_SUN_LIGHTS > 0 || NUM_DIR_LIGHTS > 0 || NUM_POINT_LIGHTS > 0 || NUM_SPOT_LIGHTS > 0 )
		float EssMs = material.dfg.x + material.dfg.y;
		material.multiScatteringCompensation = 1.0 + material.specularColorBlended * ( 1.0 / EssMs - 1.0 );
	#endif
#endif
IncidentLight directLight;
#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )
	PointLight pointLight;
	#if defined( USE_SHADOWMAP ) && NUM_POINT_LIGHT_SHADOWS > 0
	PointLightShadow pointLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
		pointLight = pointLights[ i ];
		getPointLightInfo( pointLight, geometryPosition, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_POINT_LIGHT_SHADOWS ) && ( defined( SHADOWMAP_TYPE_PCF ) || defined( SHADOWMAP_TYPE_BASIC ) )
		pointLightShadow = pointLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getPointShadow( pointShadowMap[ i ], pointLightShadow.shadowMapSize, pointLightShadow.shadowIntensity, pointLightShadow.shadowBias, pointLightShadow.shadowRadius, vPointShadowCoord[ i ], pointLightShadow.shadowCameraNear, pointLightShadow.shadowCameraFar ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )
	SpotLight spotLight;
	vec4 spotColor;
	vec3 spotLightCoord;
	bool inSpotLightMap;
	#if defined( USE_SHADOWMAP ) && NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
		spotLight = spotLights[ i ];
		getSpotLightInfo( spotLight, geometryPosition, directLight );
		#if ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#define SPOT_LIGHT_MAP_INDEX UNROLLED_LOOP_INDEX
		#elif ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		#define SPOT_LIGHT_MAP_INDEX NUM_SPOT_LIGHT_MAPS
		#else
		#define SPOT_LIGHT_MAP_INDEX ( UNROLLED_LOOP_INDEX - NUM_SPOT_LIGHT_SHADOWS + NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#endif
		#if ( SPOT_LIGHT_MAP_INDEX < NUM_SPOT_LIGHT_MAPS )
			spotLightCoord = vSpotLightCoord[ i ].xyz / vSpotLightCoord[ i ].w;
			inSpotLightMap = all( lessThan( abs( spotLightCoord * 2. - 1. ), vec3( 1.0 ) ) );
			spotColor = texture2D( spotLightMap[ SPOT_LIGHT_MAP_INDEX ], spotLightCoord.xy );
			directLight.color = inSpotLightMap ? directLight.color * spotColor.rgb : directLight.color;
		#endif
		#undef SPOT_LIGHT_MAP_INDEX
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		spotLightShadow = spotLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowIntensity, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_SUN_LIGHTS > 0 ) && defined( RE_Direct )
	SunLight sunLight;
	#if defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
	SunLightShadow sunLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SUN_LIGHTS; i ++ ) {
		sunLight = sunLights[ i ];
		getSunLightInfo( sunLight, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_SUN_LIGHT_SHADOWS )
		sunLightShadow = sunLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getSunShadow( sunShadowMap[ i ], sunLightShadow, UNROLLED_LOOP_INDEX ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )
	RectAreaLight rectAreaLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_RECT_AREA_LIGHTS; i ++ ) {
		rectAreaLight = rectAreaLights[ i ];
		RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if defined( RE_IndirectDiffuse )
	vec3 iblIrradiance = vec3( 0.0 );
	vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );
	#if defined( USE_LIGHT_PROBES )
		irradiance += getLightProbeIrradiance( lightProbe, geometryNormal );
	#endif
	#if ( NUM_HEMI_LIGHTS > 0 )
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
			irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );
		}
		#pragma unroll_loop_end
	#endif
	#ifdef USE_LIGHT_PROBES_GRID
		vec3 probeWorldPos = ( ( vec4( geometryPosition, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
		vec3 probeWorldNormal = transformNormalByInverseViewMatrix( geometryNormal, viewMatrix );
		irradiance += getLightProbeGridIrradiance( probeWorldPos, probeWorldNormal );
	#endif
#endif
#if defined( RE_IndirectSpecular )
	vec3 radiance = vec3( 0.0 );
	vec3 clearcoatRadiance = vec3( 0.0 );
#endif`,PM=`#if defined( RE_IndirectDiffuse )
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;
		irradiance += lightMapIrradiance;
	#endif
	#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
		#if defined( STANDARD ) || defined( LAMBERT ) || defined( PHONG )
			iblIrradiance += getIBLIrradiance( geometryNormal );
		#endif
	#endif
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
	#ifdef USE_ANISOTROPY
		vec3 iblRadiance = getIBLAnisotropyRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );
	#else
		vec3 iblRadiance = getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
	#endif
	#ifdef USE_RETROREFLECTION
		#ifdef USE_ANISOTROPY
			vec3 retroIBLRadiance = getIBLAnisotropyRetroRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );
		#else
			vec3 retroIBLRadiance = getIBLRetroRadiance( geometryViewDir, geometryNormal, material.roughness );
		#endif
		iblRadiance = mix( iblRadiance, retroIBLRadiance, saturate( material.retroreflectivity ) );
	#endif
	radiance += iblRadiance;
	#ifdef USE_CLEARCOAT
		clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );
	#endif
#endif`,IM=`#if defined( RE_IndirectDiffuse )
	#if defined( LAMBERT ) || defined( PHONG )
		irradiance += iblIrradiance;
	#endif
	RE_IndirectDiffuse( irradiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif
#if defined( RE_IndirectSpecular )
	RE_IndirectSpecular( radiance, iblIrradiance, clearcoatRadiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif`,LM=`#ifdef USE_LIGHT_PROBES_GRID
uniform highp sampler3D probesSH;
uniform vec3 probesMin;
uniform vec3 probesMax;
uniform vec3 probesResolution;
vec3 getLightProbeGridIrradiance( vec3 worldPos, vec3 worldNormal ) {
	vec3 res = probesResolution;
	vec3 gridRange = probesMax - probesMin;
	vec3 resMinusOne = res - 1.0;
	vec3 probeSpacing = gridRange / resMinusOne;
	vec3 samplePos = worldPos + worldNormal * probeSpacing * 0.5;
	vec3 uvw = clamp( ( samplePos - probesMin ) / gridRange, 0.0, 1.0 );
	uvw = uvw * resMinusOne / res + 0.5 / res;
	float nz          = res.z;
	float paddedSlices = nz + 2.0;
	float atlasDepth  = 7.0 * paddedSlices;
	float uvZBase     = uvw.z * nz + 1.0;
	vec4 s0 = texture( probesSH, vec3( uvw.xy, ( uvZBase                       ) / atlasDepth ) );
	vec4 s1 = texture( probesSH, vec3( uvw.xy, ( uvZBase +       paddedSlices   ) / atlasDepth ) );
	vec4 s2 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 2.0 * paddedSlices   ) / atlasDepth ) );
	vec4 s3 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 3.0 * paddedSlices   ) / atlasDepth ) );
	vec4 s4 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 4.0 * paddedSlices   ) / atlasDepth ) );
	vec4 s5 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 5.0 * paddedSlices   ) / atlasDepth ) );
	vec4 s6 = texture( probesSH, vec3( uvw.xy, ( uvZBase + 6.0 * paddedSlices   ) / atlasDepth ) );
	vec3 c0 = s0.xyz;
	vec3 c1 = vec3( s0.w, s1.xy );
	vec3 c2 = vec3( s1.zw, s2.x );
	vec3 c3 = s2.yzw;
	vec3 c4 = s3.xyz;
	vec3 c5 = vec3( s3.w, s4.xy );
	vec3 c6 = vec3( s4.zw, s5.x );
	vec3 c7 = s5.yzw;
	vec3 c8 = s6.xyz;
	float x = worldNormal.x, y = worldNormal.y, z = worldNormal.z;
	vec3 result = c0 * 0.886227;
	result += c1 * 2.0 * 0.511664 * y;
	result += c2 * 2.0 * 0.511664 * z;
	result += c3 * 2.0 * 0.511664 * x;
	result += c4 * 2.0 * 0.429043 * x * y;
	result += c5 * 2.0 * 0.429043 * y * z;
	result += c6 * ( 0.743125 * z * z - 0.247708 );
	result += c7 * 2.0 * 0.429043 * x * z;
	result += c8 * 0.429043 * ( x * x - y * y );
	return max( result, vec3( 0.0 ) );
}
#endif`,DM=`#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
	gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( vFragDepth ) * logDepthBufFC * 0.5;
#endif`,NM=`#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
	uniform float logDepthBufFC;
	varying float vFragDepth;
	varying float vIsPerspective;
#endif`,FM=`#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
	varying float vFragDepth;
	varying float vIsPerspective;
#endif`,UM=`#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
	vFragDepth = 1.0 + gl_Position.w;
	vIsPerspective = float( isPerspectiveMatrix( projectionMatrix ) );
#endif`,BM=`#ifdef USE_MAP
	vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	#ifdef DECODE_VIDEO_TEXTURE
		sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );
	#endif
	diffuseColor *= sampledDiffuseColor;
#endif`,OM=`#ifdef USE_MAP
	uniform sampler2D map;
#endif`,zM=`#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
	#if defined( USE_POINTS_UV )
		vec2 uv = vUv;
	#else
		vec2 uv = ( uvTransform * vec3( gl_PointCoord.x, 1.0 - gl_PointCoord.y, 1 ) ).xy;
	#endif
#endif
#ifdef USE_MAP
	diffuseColor *= texture2D( map, uv );
#endif
#ifdef USE_ALPHAMAP
	diffuseColor.a *= texture2D( alphaMap, uv ).g;
#endif`,kM=`#if defined( USE_POINTS_UV )
	varying vec2 vUv;
#else
	#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
		uniform mat3 uvTransform;
	#endif
#endif
#ifdef USE_MAP
	uniform sampler2D map;
#endif
#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,GM=`float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
	vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );
	metalnessFactor *= texelMetalness.b;
#endif`,VM=`#ifdef USE_METALNESSMAP
	uniform sampler2D metalnessMap;
#endif`,HM=`#ifdef USE_INSTANCING_MORPH
	float morphTargetInfluences[ MORPHTARGETS_COUNT ];
	float morphTargetBaseInfluence = texelFetch( morphTexture, ivec2( 0, gl_InstanceID ), 0 ).r;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		morphTargetInfluences[i] =  texelFetch( morphTexture, ivec2( i + 1, gl_InstanceID ), 0 ).r;
	}
#endif`,WM=`#if defined( USE_MORPHCOLORS )
	vColor *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		#if defined( USE_COLOR_ALPHA )
			if ( morphTargetInfluences[ i ] != 0.0 ) vColor += getMorph( gl_VertexID, i, 2 ) * morphTargetInfluences[ i ];
		#elif defined( USE_COLOR )
			if ( morphTargetInfluences[ i ] != 0.0 ) vColor += getMorph( gl_VertexID, i, 2 ).rgb * morphTargetInfluences[ i ];
		#endif
	}
#endif`,XM=`#ifdef USE_MORPHNORMALS
	objectNormal *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		if ( morphTargetInfluences[ i ] != 0.0 ) objectNormal += getMorph( gl_VertexID, i, 1 ).xyz * morphTargetInfluences[ i ];
	}
#endif`,qM=`#ifdef USE_MORPHTARGETS
	#ifndef USE_INSTANCING_MORPH
		uniform float morphTargetBaseInfluence;
		uniform float morphTargetInfluences[ MORPHTARGETS_COUNT ];
	#endif
	uniform sampler2DArray morphTargetsTexture;
	uniform ivec2 morphTargetsTextureSize;
	vec4 getMorph( const in int vertexIndex, const in int morphTargetIndex, const in int offset ) {
		int texelIndex = vertexIndex * MORPHTARGETS_TEXTURE_STRIDE + offset;
		int y = texelIndex / morphTargetsTextureSize.x;
		int x = texelIndex - y * morphTargetsTextureSize.x;
		ivec3 morphUV = ivec3( x, y, morphTargetIndex );
		return texelFetch( morphTargetsTexture, morphUV, 0 );
	}
#endif`,YM=`#ifdef USE_MORPHTARGETS
	transformed *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		if ( morphTargetInfluences[ i ] != 0.0 ) transformed += getMorph( gl_VertexID, i, 0 ).xyz * morphTargetInfluences[ i ];
	}
#endif`,ZM=`float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
#ifdef FLAT_SHADED
	vec3 fdx = dFdx( vViewPosition );
	vec3 fdy = dFdy( vViewPosition );
	vec3 normal = normalize( cross( fdx, fdy ) );
#else
	vec3 normal = normalize( vNormal );
	#ifdef DOUBLE_SIDED
		normal *= faceDirection;
	#endif
#endif
#if defined( USE_NORMALMAP_TANGENTSPACE ) || defined( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY )
	#ifdef USE_TANGENT
		mat3 tbn = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn = getTangentFrame( - vViewPosition, normal,
		#if defined( USE_NORMALMAP )
			vNormalMapUv
		#elif defined( USE_CLEARCOAT_NORMALMAP )
			vClearcoatNormalMapUv
		#else
			vUv
		#endif
		);
	#endif
	#ifdef DOUBLE_SIDED
		tbn[0] *= faceDirection;
		tbn[1] *= faceDirection;
	#endif
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	#ifdef USE_TANGENT
		mat3 tbn2 = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn2 = getTangentFrame( - vViewPosition, normal, vClearcoatNormalMapUv );
	#endif
	#ifdef DOUBLE_SIDED
		tbn2[0] *= faceDirection;
		tbn2[1] *= faceDirection;
	#endif
#endif
vec3 nonPerturbedNormal = normal;`,$M=`#ifdef USE_NORMALMAP_OBJECTSPACE
	normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	#ifdef FLIP_SIDED
		normal = - normal;
	#endif
	#ifdef DOUBLE_SIDED
		normal = normal * faceDirection;
	#endif
	normal = normalize( normalMatrix * normal );
#elif defined( USE_NORMALMAP_TANGENTSPACE )
	vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	#if defined( USE_PACKED_NORMALMAP )
		mapN = vec3( mapN.xy, sqrt( saturate( 1.0 - dot( mapN.xy, mapN.xy ) ) ) );
	#endif
	mapN.xy *= normalScale;
	normal = normalize( tbn * mapN );
#elif defined( USE_BUMPMAP )
	normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
#endif`,JM=`#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif`,KM=`#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif`,jM=`#ifndef FLAT_SHADED
	vNormal = normalize( transformedNormal );
	#ifdef USE_TANGENT
		vTangent = normalize( transformedTangent );
		vBitangent = normalize( cross( vNormal, vTangent ) * tangent.w );
		#ifdef FLIP_SIDED
			vBitangent = - vBitangent;
		#endif
	#endif
#endif`,QM=`#ifdef USE_NORMALMAP
	uniform sampler2D normalMap;
	uniform vec2 normalScale;
#endif
#ifdef USE_NORMALMAP_OBJECTSPACE
	uniform mat3 normalMatrix;
#endif
#if ! defined ( USE_TANGENT ) && ( defined ( USE_NORMALMAP_TANGENTSPACE ) || defined ( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY ) )
	mat3 getTangentFrame( vec3 eye_pos, vec3 surf_norm, vec2 uv ) {
		vec3 q0 = dFdx( eye_pos.xyz );
		vec3 q1 = dFdy( eye_pos.xyz );
		vec2 st0 = dFdx( uv.st );
		vec2 st1 = dFdy( uv.st );
		vec3 N = surf_norm;
		vec3 q1perp = cross( q1, N );
		vec3 q0perp = cross( N, q0 );
		vec3 T = q1perp * st0.x + q0perp * st1.x;
		vec3 B = q1perp * st0.y + q0perp * st1.y;
		float det = max( dot( T, T ), dot( B, B ) );
		float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
		return mat3( T * scale, B * scale, N );
	}
#endif`,eS=`#ifdef USE_CLEARCOAT
	vec3 clearcoatNormal = nonPerturbedNormal;
#endif`,tS=`#ifdef USE_CLEARCOAT_NORMALMAP
	vec3 clearcoatMapN = texture2D( clearcoatNormalMap, vClearcoatNormalMapUv ).xyz * 2.0 - 1.0;
	clearcoatMapN.xy *= clearcoatNormalScale;
	clearcoatNormal = normalize( tbn2 * clearcoatMapN );
#endif`,nS=`#ifdef USE_CLEARCOATMAP
	uniform sampler2D clearcoatMap;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	uniform sampler2D clearcoatNormalMap;
	uniform vec2 clearcoatNormalScale;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	uniform sampler2D clearcoatRoughnessMap;
#endif`,iS=`#ifdef USE_IRIDESCENCEMAP
	uniform sampler2D iridescenceMap;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	uniform sampler2D iridescenceThicknessMap;
#endif`,rS=`#ifdef OPAQUE
diffuseColor.a = 1.0;
#endif
#ifdef USE_TRANSMISSION
diffuseColor.a *= material.transmissionAlpha;
#endif
gl_FragColor = vec4( outgoingLight, diffuseColor.a );`,sS=`vec3 packNormalToRGB( const in vec3 normal ) {
	return normalize( normal ) * 0.5 + 0.5;
}
vec3 unpackRGBToNormal( const in vec3 rgb ) {
	return 2.0 * rgb.xyz - 1.0;
}
const float PackUpscale = 256. / 255.;const float UnpackDownscale = 255. / 256.;const float ShiftRight8 = 1. / 256.;
const float Inv255 = 1. / 255.;
const vec4 PackFactors = vec4( 1.0, 256.0, 256.0 * 256.0, 256.0 * 256.0 * 256.0 );
const vec2 UnpackFactors2 = vec2( UnpackDownscale, 1.0 / PackFactors.g );
const vec3 UnpackFactors3 = vec3( UnpackDownscale / PackFactors.rg, 1.0 / PackFactors.b );
const vec4 UnpackFactors4 = vec4( UnpackDownscale / PackFactors.rgb, 1.0 / PackFactors.a );
vec4 packDepthToRGBA( const in float v ) {
	if( v <= 0.0 )
		return vec4( 0., 0., 0., 0. );
	if( v >= 1.0 )
		return vec4( 1., 1., 1., 1. );
	float vuf;
	float af = modf( v * PackFactors.a, vuf );
	float bf = modf( vuf * ShiftRight8, vuf );
	float gf = modf( vuf * ShiftRight8, vuf );
	return vec4( vuf * Inv255, gf * PackUpscale, bf * PackUpscale, af );
}
vec3 packDepthToRGB( const in float v ) {
	if( v <= 0.0 )
		return vec3( 0., 0., 0. );
	if( v >= 1.0 )
		return vec3( 1., 1., 1. );
	float vuf;
	float bf = modf( v * PackFactors.b, vuf );
	float gf = modf( vuf * ShiftRight8, vuf );
	return vec3( vuf * Inv255, gf * PackUpscale, bf );
}
vec2 packDepthToRG( const in float v ) {
	if( v <= 0.0 )
		return vec2( 0., 0. );
	if( v >= 1.0 )
		return vec2( 1., 1. );
	float vuf;
	float gf = modf( v * 256., vuf );
	return vec2( vuf * Inv255, gf );
}
float unpackRGBAToDepth( const in vec4 v ) {
	return dot( v, UnpackFactors4 );
}
float unpackRGBToDepth( const in vec3 v ) {
	return dot( v, UnpackFactors3 );
}
float unpackRGToDepth( const in vec2 v ) {
	return v.r * UnpackFactors2.r + v.g * UnpackFactors2.g;
}
vec4 pack2HalfToRGBA( const in vec2 v ) {
	vec4 r = vec4( v.x, fract( v.x * 255.0 ), v.y, fract( v.y * 255.0 ) );
	return vec4( r.x - r.y / 255.0, r.y, r.z - r.w / 255.0, r.w );
}
vec2 unpackRGBATo2Half( const in vec4 v ) {
	return vec2( v.x + ( v.y / 255.0 ), v.z + ( v.w / 255.0 ) );
}
float viewZToOrthographicDepth( const in float viewZ, const in float near, const in float far ) {
	return ( viewZ + near ) / ( near - far );
}
float orthographicDepthToViewZ( const in float depth, const in float near, const in float far ) {
	#ifdef USE_REVERSED_DEPTH_BUFFER
	
		return depth * ( far - near ) - far;
	#else
		return depth * ( near - far ) - near;
	#endif
}
float viewZToPerspectiveDepth( const in float viewZ, const in float near, const in float far ) {
	return ( ( near + viewZ ) * far ) / ( ( far - near ) * viewZ );
}
float perspectiveDepthToViewZ( const in float depth, const in float near, const in float far ) {
	
	#ifdef USE_REVERSED_DEPTH_BUFFER
		return ( near * far ) / ( ( near - far ) * depth - near );
	#else
		return ( near * far ) / ( ( far - near ) * depth - far );
	#endif
}`,oS=`#ifdef PREMULTIPLIED_ALPHA
	gl_FragColor.rgb *= gl_FragColor.a;
#endif`,aS=`vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`,lS=`#ifdef DITHERING
	gl_FragColor.rgb = dithering( gl_FragColor.rgb );
#endif`,cS=`#ifdef DITHERING
	vec3 dithering( vec3 color ) {
		float grid_position = rand( gl_FragCoord.xy );
		vec3 dither_shift_RGB = vec3( 0.25 / 255.0, -0.25 / 255.0, 0.25 / 255.0 );
		dither_shift_RGB = mix( 2.0 * dither_shift_RGB, -2.0 * dither_shift_RGB, grid_position );
		return color + dither_shift_RGB;
	}
#endif`,uS=`float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
	vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
	roughnessFactor *= texelRoughness.g;
#endif`,hS=`#ifdef USE_ROUGHNESSMAP
	uniform sampler2D roughnessMap;
#endif`,fS=`#if NUM_SPOT_LIGHT_COORDS > 0
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#if NUM_SPOT_LIGHT_MAPS > 0
	uniform sampler2D spotLightMap[ NUM_SPOT_LIGHT_MAPS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_SUN_LIGHT_SHADOWS > 0
		#define SUN_LIGHT_CASCADES 2
		#if defined( SHADOWMAP_TYPE_PCF )
			uniform sampler2DShadow sunShadowMap[ NUM_SUN_LIGHT_SHADOWS ];
		#else
			uniform sampler2D sunShadowMap[ NUM_SUN_LIGHT_SHADOWS ];
		#endif
		uniform mat4 sunShadowMatrix[ NUM_SUN_LIGHT_SHADOWS * SUN_LIGHT_CASCADES ];
		uniform vec4 sunShadowCascade[ NUM_SUN_LIGHT_SHADOWS * SUN_LIGHT_CASCADES ];
		varying vec4 vSunShadowWorldPosition;
		varying vec3 vSunShadowWorldNormal;
		struct SunLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SunLightShadow sunLightShadows[ NUM_SUN_LIGHT_SHADOWS ];
	#endif
	#if NUM_DIR_LIGHT_SHADOWS > 0
		#if defined( SHADOWMAP_TYPE_PCF )
			uniform sampler2DShadow directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
		#else
			uniform sampler2D directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
		#endif
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		#if defined( SHADOWMAP_TYPE_PCF )
			uniform sampler2DShadow spotShadowMap[ NUM_SPOT_LIGHT_SHADOWS ];
		#else
			uniform sampler2D spotShadowMap[ NUM_SPOT_LIGHT_SHADOWS ];
		#endif
		struct SpotLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		#if defined( SHADOWMAP_TYPE_PCF )
			uniform samplerCubeShadow pointShadowMap[ NUM_POINT_LIGHT_SHADOWS ];
		#elif defined( SHADOWMAP_TYPE_BASIC )
			uniform samplerCube pointShadowMap[ NUM_POINT_LIGHT_SHADOWS ];
		#endif
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif
	#if defined( SHADOWMAP_TYPE_PCF )
		float interleavedGradientNoise( vec2 position ) {
			return fract( 52.9829189 * fract( dot( position, vec2( 0.06711056, 0.00583715 ) ) ) );
		}
		vec2 vogelDiskSample( int sampleIndex, int samplesCount, float phi ) {
			const float goldenAngle = 2.399963229728653;
			float r = sqrt( ( float( sampleIndex ) + 0.5 ) / float( samplesCount ) );
			float theta = float( sampleIndex ) * goldenAngle + phi;
			return vec2( cos( theta ), sin( theta ) ) * r;
		}
	#endif
	#if defined( SHADOWMAP_TYPE_PCF )
		float getShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
			float shadow = 1.0;
			shadowCoord.xyz /= shadowCoord.w;
			shadowCoord.z += shadowBias;
			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
			if ( frustumTest ) {
				vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
				float radius = shadowRadius * texelSize.x;
				float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
				shadow = (
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 0, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 1, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 2, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 3, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 4, 5, phi ) * radius, shadowCoord.z ) )
				) * 0.2;
			}
			return mix( 1.0, shadow, shadowIntensity );
		}
	#elif defined( SHADOWMAP_TYPE_VSM )
		float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
			float shadow = 1.0;
			shadowCoord.xyz /= shadowCoord.w;
			#ifdef USE_REVERSED_DEPTH_BUFFER
				shadowCoord.z -= shadowBias;
			#else
				shadowCoord.z += shadowBias;
			#endif
			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
			if ( frustumTest ) {
				vec2 distribution = texture2D( shadowMap, shadowCoord.xy ).rg;
				float mean = distribution.x;
				float variance = distribution.y * distribution.y;
				#ifdef USE_REVERSED_DEPTH_BUFFER
					float hard_shadow = step( mean, shadowCoord.z );
				#else
					float hard_shadow = step( shadowCoord.z, mean );
				#endif
				
				if ( hard_shadow == 1.0 ) {
					shadow = 1.0;
				} else {
					variance = max( variance, 0.0000001 );
					float d = shadowCoord.z - mean;
					float p_max = variance / ( variance + d * d );
					p_max = clamp( ( p_max - 0.3 ) / 0.65, 0.0, 1.0 );
					shadow = max( hard_shadow, p_max );
				}
			}
			return mix( 1.0, shadow, shadowIntensity );
		}
	#else
		float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
			float shadow = 1.0;
			shadowCoord.xyz /= shadowCoord.w;
			#ifdef USE_REVERSED_DEPTH_BUFFER
				shadowCoord.z -= shadowBias;
			#else
				shadowCoord.z += shadowBias;
			#endif
			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
			if ( frustumTest ) {
				float depth = texture2D( shadowMap, shadowCoord.xy ).r;
				#ifdef USE_REVERSED_DEPTH_BUFFER
					shadow = step( depth, shadowCoord.z );
				#else
					shadow = step( shadowCoord.z, depth );
				#endif
			}
			return mix( 1.0, shadow, shadowIntensity );
		}
	#endif
	#if NUM_SUN_LIGHT_SHADOWS > 0
		float getSunShadow(
			#if defined( SHADOWMAP_TYPE_PCF )
				sampler2DShadow shadowMap,
			#else
				sampler2D shadowMap,
			#endif
			SunLightShadow sunLightShadow,
			int shadowIndex
		) {
			vec4 shadowWorldPosition = vec4( vSunShadowWorldPosition.xyz + vSunShadowWorldNormal * sunLightShadow.shadowNormalBias, 1.0 );
			float viewDepth = vSunShadowWorldPosition.w;
			int cascadeOffset = shadowIndex * SUN_LIGHT_CASCADES;
			float shadow = 1.0;
			for ( int i = SUN_LIGHT_CASCADES - 1; i >= 0; i -- ) {
				vec4 cascade = sunShadowCascade[ cascadeOffset + i ];
				if ( viewDepth >= cascade.x && viewDepth < cascade.y ) {
					float cascadeShadow = getShadow(
						shadowMap,
						sunLightShadow.shadowMapSize,
						sunLightShadow.shadowIntensity,
						sunLightShadow.shadowBias,
						sunLightShadow.shadowRadius,
						sunShadowMatrix[ cascadeOffset + i ] * shadowWorldPosition
					);
					shadow = mix( cascadeShadow, shadow, smoothstep( cascade.z, cascade.y, viewDepth ) );
				}
			}
			return shadow;
		}
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
	#if defined( SHADOWMAP_TYPE_PCF )
	float getPointShadow( samplerCubeShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
		float shadow = 1.0;
		vec3 lightToPosition = shadowCoord.xyz;
		vec3 bd3D = normalize( lightToPosition );
		vec3 absVec = abs( lightToPosition );
		float viewSpaceZ = max( max( absVec.x, absVec.y ), absVec.z );
		if ( viewSpaceZ - shadowCameraFar <= 0.0 && viewSpaceZ - shadowCameraNear >= 0.0 ) {
			#ifdef USE_REVERSED_DEPTH_BUFFER
				float dp = ( shadowCameraNear * ( shadowCameraFar - viewSpaceZ ) ) / ( viewSpaceZ * ( shadowCameraFar - shadowCameraNear ) );
				dp -= shadowBias;
			#else
				float dp = ( shadowCameraFar * ( viewSpaceZ - shadowCameraNear ) ) / ( viewSpaceZ * ( shadowCameraFar - shadowCameraNear ) );
				dp += shadowBias;
			#endif
			float texelSize = shadowRadius / shadowMapSize.x;
			vec3 absDir = abs( bd3D );
			vec3 tangent = absDir.x > absDir.z ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
			tangent = normalize( cross( bd3D, tangent ) );
			vec3 bitangent = cross( bd3D, tangent );
			float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
			vec2 sample0 = vogelDiskSample( 0, 5, phi );
			vec2 sample1 = vogelDiskSample( 1, 5, phi );
			vec2 sample2 = vogelDiskSample( 2, 5, phi );
			vec2 sample3 = vogelDiskSample( 3, 5, phi );
			vec2 sample4 = vogelDiskSample( 4, 5, phi );
			shadow = (
				texture( shadowMap, vec4( bd3D + ( tangent * sample0.x + bitangent * sample0.y ) * texelSize, dp ) ) +
				texture( shadowMap, vec4( bd3D + ( tangent * sample1.x + bitangent * sample1.y ) * texelSize, dp ) ) +
				texture( shadowMap, vec4( bd3D + ( tangent * sample2.x + bitangent * sample2.y ) * texelSize, dp ) ) +
				texture( shadowMap, vec4( bd3D + ( tangent * sample3.x + bitangent * sample3.y ) * texelSize, dp ) ) +
				texture( shadowMap, vec4( bd3D + ( tangent * sample4.x + bitangent * sample4.y ) * texelSize, dp ) )
			) * 0.2;
		}
		return mix( 1.0, shadow, shadowIntensity );
	}
	#elif defined( SHADOWMAP_TYPE_BASIC )
	float getPointShadow( samplerCube shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
		float shadow = 1.0;
		vec3 lightToPosition = shadowCoord.xyz;
		vec3 absVec = abs( lightToPosition );
		float viewSpaceZ = max( max( absVec.x, absVec.y ), absVec.z );
		if ( viewSpaceZ - shadowCameraFar <= 0.0 && viewSpaceZ - shadowCameraNear >= 0.0 ) {
			float dp = ( shadowCameraFar * ( viewSpaceZ - shadowCameraNear ) ) / ( viewSpaceZ * ( shadowCameraFar - shadowCameraNear ) );
			dp += shadowBias;
			vec3 bd3D = normalize( lightToPosition );
			float depth = textureCube( shadowMap, bd3D ).r;
			#ifdef USE_REVERSED_DEPTH_BUFFER
				depth = 1.0 - depth;
			#endif
			shadow = step( dp, depth );
		}
		return mix( 1.0, shadow, shadowIntensity );
	}
	#endif
	#endif
#endif`,dS=`#if NUM_SPOT_LIGHT_COORDS > 0
	uniform mat4 spotLightMatrix[ NUM_SPOT_LIGHT_COORDS ];
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_SUN_LIGHT_SHADOWS > 0
		varying vec4 vSunShadowWorldPosition;
		varying vec3 vSunShadowWorldNormal;
	#endif
	#if NUM_DIR_LIGHT_SHADOWS > 0
		uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		struct SpotLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		uniform mat4 pointShadowMatrix[ NUM_POINT_LIGHT_SHADOWS ];
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif
#endif`,pS=`#if ( defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 || NUM_SUN_LIGHT_SHADOWS > 0 || NUM_POINT_LIGHT_SHADOWS > 0 ) ) || ( NUM_SPOT_LIGHT_COORDS > 0 )
	#ifdef HAS_NORMAL
		vec3 shadowWorldNormal = transformNormalByInverseViewMatrix( transformedNormal, viewMatrix );
	#else
		vec3 shadowWorldNormal = vec3( 0.0 );
	#endif
	vec4 shadowWorldPosition;
#endif
#if defined( USE_SHADOWMAP )
	#if NUM_SUN_LIGHT_SHADOWS > 0
		vSunShadowWorldPosition = vec4( worldPosition.xyz, - mvPosition.z );
		vSunShadowWorldNormal = shadowWorldNormal;
	#endif
	#if NUM_DIR_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );
			vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * pointLightShadows[ i ].shadowNormalBias, 0 );
			vPointShadowCoord[ i ] = pointShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
#endif
#if NUM_SPOT_LIGHT_COORDS > 0
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
		shadowWorldPosition = worldPosition;
		#if ( defined( USE_SHADOWMAP ) && UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
			shadowWorldPosition.xyz += shadowWorldNormal * spotLightShadows[ i ].shadowNormalBias;
		#endif
		vSpotLightCoord[ i ] = spotLightMatrix[ i ] * shadowWorldPosition;
	}
	#pragma unroll_loop_end
#endif`,mS=`float getShadowMask() {
	float shadow = 1.0;
	#ifdef USE_SHADOWMAP
	#if NUM_SUN_LIGHT_SHADOWS > 0
	SunLightShadow sunLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SUN_LIGHT_SHADOWS; i ++ ) {
		sunLight = sunLightShadows[ i ];
		shadow *= receiveShadow ? getSunShadow( sunShadowMap[ i ], sunLight, UNROLLED_LOOP_INDEX ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
		directionalLight = directionalLightShadows[ i ];
		shadow *= receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLight.shadowMapSize, directionalLight.shadowIntensity, directionalLight.shadowBias, directionalLight.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_SHADOWS; i ++ ) {
		spotLight = spotLightShadows[ i ];
		shadow *= receiveShadow ? getShadow( spotShadowMap[ i ], spotLight.shadowMapSize, spotLight.shadowIntensity, spotLight.shadowBias, spotLight.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0 && ( defined( SHADOWMAP_TYPE_PCF ) || defined( SHADOWMAP_TYPE_BASIC ) )
	PointLightShadow pointLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
		pointLight = pointLightShadows[ i ];
		shadow *= receiveShadow ? getPointShadow( pointShadowMap[ i ], pointLight.shadowMapSize, pointLight.shadowIntensity, pointLight.shadowBias, pointLight.shadowRadius, vPointShadowCoord[ i ], pointLight.shadowCameraNear, pointLight.shadowCameraFar ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#endif
	return shadow;
}`,gS=`#ifdef USE_SKINNING
	mat4 boneMatX = getBoneMatrix( skinIndex.x );
	mat4 boneMatY = getBoneMatrix( skinIndex.y );
	mat4 boneMatZ = getBoneMatrix( skinIndex.z );
	mat4 boneMatW = getBoneMatrix( skinIndex.w );
#endif`,vS=`#ifdef USE_SKINNING
	uniform mat4 bindMatrix;
	uniform mat4 bindMatrixInverse;
	uniform highp sampler2D boneTexture;
	mat4 getBoneMatrix( const in float i ) {
		int size = textureSize( boneTexture, 0 ).x;
		int j = int( i ) * 4;
		int x = j % size;
		int y = j / size;
		vec4 v1 = texelFetch( boneTexture, ivec2( x, y ), 0 );
		vec4 v2 = texelFetch( boneTexture, ivec2( x + 1, y ), 0 );
		vec4 v3 = texelFetch( boneTexture, ivec2( x + 2, y ), 0 );
		vec4 v4 = texelFetch( boneTexture, ivec2( x + 3, y ), 0 );
		return mat4( v1, v2, v3, v4 );
	}
#endif`,xS=`#ifdef USE_SKINNING
	vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );
	vec4 skinned = vec4( 0.0 );
	skinned += boneMatX * skinVertex * skinWeight.x;
	skinned += boneMatY * skinVertex * skinWeight.y;
	skinned += boneMatZ * skinVertex * skinWeight.z;
	skinned += boneMatW * skinVertex * skinWeight.w;
	transformed = ( bindMatrixInverse * skinned ).xyz;
#endif`,yS=`#ifdef USE_SKINNING
	mat4 skinMatrix = mat4( 0.0 );
	skinMatrix += skinWeight.x * boneMatX;
	skinMatrix += skinWeight.y * boneMatY;
	skinMatrix += skinWeight.z * boneMatZ;
	skinMatrix += skinWeight.w * boneMatW;
	skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
	objectNormal = vec4( skinMatrix * vec4( objectNormal, 0.0 ) ).xyz;
	#ifdef USE_TANGENT
		objectTangent = vec4( skinMatrix * vec4( objectTangent, 0.0 ) ).xyz;
	#endif
#endif`,_S=`float specularStrength;
#ifdef USE_SPECULARMAP
	vec4 texelSpecular = texture2D( specularMap, vSpecularMapUv );
	specularStrength = texelSpecular.r;
#else
	specularStrength = 1.0;
#endif`,MS=`#ifdef USE_SPECULARMAP
	uniform sampler2D specularMap;
#endif`,SS=`#if defined( TONE_MAPPING )
	gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );
#endif`,bS=`#ifndef saturate
#define saturate( a ) clamp( a, 0.0, 1.0 )
#endif
uniform float toneMappingExposure;
vec3 LinearToneMapping( vec3 color ) {
	return saturate( toneMappingExposure * color );
}
vec3 ReinhardToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	return saturate( color / ( vec3( 1.0 ) + color ) );
}
vec3 CineonToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	color = max( vec3( 0.0 ), color - 0.004 );
	return pow( ( color * ( 6.2 * color + 0.5 ) ) / ( color * ( 6.2 * color + 1.7 ) + 0.06 ), vec3( 2.2 ) );
}
vec3 RRTAndODTFit( vec3 v ) {
	vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
	vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
	return a / b;
}
vec3 ACESFilmicToneMapping( vec3 color ) {
	const mat3 ACESInputMat = mat3(
		vec3( 0.59719, 0.07600, 0.02840 ),		vec3( 0.35458, 0.90834, 0.13383 ),
		vec3( 0.04823, 0.01566, 0.83777 )
	);
	const mat3 ACESOutputMat = mat3(
		vec3(  1.60475, -0.10208, -0.00327 ),		vec3( -0.53108,  1.10813, -0.07276 ),
		vec3( -0.07367, -0.00605,  1.07602 )
	);
	color *= toneMappingExposure / 0.6;
	color = ACESInputMat * color;
	color = RRTAndODTFit( color );
	color = ACESOutputMat * color;
	return saturate( color );
}
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
	vec3( 1.6605, - 0.1246, - 0.0182 ),
	vec3( - 0.5876, 1.1329, - 0.1006 ),
	vec3( - 0.0728, - 0.0083, 1.1187 )
);
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
	vec3( 0.6274, 0.0691, 0.0164 ),
	vec3( 0.3293, 0.9195, 0.0880 ),
	vec3( 0.0433, 0.0113, 0.8956 )
);
vec3 agxDefaultContrastApprox( vec3 x ) {
	vec3 x2 = x * x;
	vec3 x4 = x2 * x2;
	return + 15.5 * x4 * x2
		- 40.14 * x4 * x
		+ 31.96 * x4
		- 6.868 * x2 * x
		+ 0.4298 * x2
		+ 0.1191 * x
		- 0.00232;
}
vec3 AgXToneMapping( vec3 color ) {
	const mat3 AgXInsetMatrix = mat3(
		vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
		vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
		vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 )
	);
	const mat3 AgXOutsetMatrix = mat3(
		vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
		vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
		vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 )
	);
	const float AgxMinEv = - 12.47393;	const float AgxMaxEv = 4.026069;
	color *= toneMappingExposure;
	color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
	color = AgXInsetMatrix * color;
	color = max( color, 1e-10 );	color = log2( color );
	color = ( color - AgxMinEv ) / ( AgxMaxEv - AgxMinEv );
	color = clamp( color, 0.0, 1.0 );
	color = agxDefaultContrastApprox( color );
	color = AgXOutsetMatrix * color;
	color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
	color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
	color = clamp( color, 0.0, 1.0 );
	return color;
}
vec3 NeutralToneMapping( vec3 color ) {
	const float StartCompression = 0.8 - 0.04;
	const float Desaturation = 0.15;
	color *= toneMappingExposure;
	float x = min( color.r, min( color.g, color.b ) );
	float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
	color -= offset;
	float peak = max( color.r, max( color.g, color.b ) );
	if ( peak < StartCompression ) return color;
	float d = 1. - StartCompression;
	float newPeak = 1. - d * d / ( peak + d - StartCompression );
	color *= newPeak / peak;
	float g = 1. - 1. / ( Desaturation * ( peak - newPeak ) + 1. );
	return mix( color, vec3( newPeak ), g );
}
vec3 CustomToneMapping( vec3 color ) { return color; }`,wS=`#ifdef USE_TRANSMISSION
	material.transmission = transmission;
	material.transmissionAlpha = 1.0;
	material.thickness = thickness;
	material.attenuationDistance = attenuationDistance;
	material.attenuationColor = attenuationColor;
	#ifdef USE_TRANSMISSIONMAP
		material.transmission *= texture2D( transmissionMap, vTransmissionMapUv ).r;
	#endif
	#ifdef USE_THICKNESSMAP
		material.thickness *= texture2D( thicknessMap, vThicknessMapUv ).g;
	#endif
	vec3 pos = vWorldPosition;
	vec3 v = normalize( cameraPosition - pos );
	vec3 n = transformNormalByInverseViewMatrix( normal, viewMatrix );
	vec4 transmitted = getIBLVolumeRefraction(
		n, v, material.roughness, material.diffuseContribution, material.specularColorBlended, material.specularF90,
		pos, modelMatrix, viewMatrix, projectionMatrix, material.dispersion, material.ior, material.thickness,
		material.attenuationColor, material.attenuationDistance );
	material.transmissionAlpha = mix( material.transmissionAlpha, transmitted.a, material.transmission );
	totalDiffuse = mix( totalDiffuse, transmitted.rgb, material.transmission );
#endif`,TS=`#ifdef USE_TRANSMISSION
	uniform float transmission;
	uniform float thickness;
	uniform float attenuationDistance;
	uniform vec3 attenuationColor;
	#ifdef USE_TRANSMISSIONMAP
		uniform sampler2D transmissionMap;
	#endif
	#ifdef USE_THICKNESSMAP
		uniform sampler2D thicknessMap;
	#endif
	uniform vec2 transmissionSamplerSize;
	uniform sampler2D transmissionSamplerMap;
	uniform mat4 modelMatrix;
	uniform mat4 projectionMatrix;
	varying vec3 vWorldPosition;
	float w0( float a ) {
		return ( 1.0 / 6.0 ) * ( a * ( a * ( - a + 3.0 ) - 3.0 ) + 1.0 );
	}
	float w1( float a ) {
		return ( 1.0 / 6.0 ) * ( a *  a * ( 3.0 * a - 6.0 ) + 4.0 );
	}
	float w2( float a ){
		return ( 1.0 / 6.0 ) * ( a * ( a * ( - 3.0 * a + 3.0 ) + 3.0 ) + 1.0 );
	}
	float w3( float a ) {
		return ( 1.0 / 6.0 ) * ( a * a * a );
	}
	float g0( float a ) {
		return w0( a ) + w1( a );
	}
	float g1( float a ) {
		return w2( a ) + w3( a );
	}
	float h0( float a ) {
		return - 1.0 + w1( a ) / ( w0( a ) + w1( a ) );
	}
	float h1( float a ) {
		return 1.0 + w3( a ) / ( w2( a ) + w3( a ) );
	}
	vec4 bicubic( sampler2D tex, vec2 uv, vec4 texelSize, float lod ) {
		uv = uv * texelSize.zw + 0.5;
		vec2 iuv = floor( uv );
		vec2 fuv = fract( uv );
		float g0x = g0( fuv.x );
		float g1x = g1( fuv.x );
		float h0x = h0( fuv.x );
		float h1x = h1( fuv.x );
		float h0y = h0( fuv.y );
		float h1y = h1( fuv.y );
		vec2 p0 = ( vec2( iuv.x + h0x, iuv.y + h0y ) - 0.5 ) * texelSize.xy;
		vec2 p1 = ( vec2( iuv.x + h1x, iuv.y + h0y ) - 0.5 ) * texelSize.xy;
		vec2 p2 = ( vec2( iuv.x + h0x, iuv.y + h1y ) - 0.5 ) * texelSize.xy;
		vec2 p3 = ( vec2( iuv.x + h1x, iuv.y + h1y ) - 0.5 ) * texelSize.xy;
		return g0( fuv.y ) * ( g0x * textureLod( tex, p0, lod ) + g1x * textureLod( tex, p1, lod ) ) +
			g1( fuv.y ) * ( g0x * textureLod( tex, p2, lod ) + g1x * textureLod( tex, p3, lod ) );
	}
	vec4 textureBicubic( sampler2D sampler, vec2 uv, float lod ) {
		vec2 fLodSize = vec2( textureSize( sampler, int( lod ) ) );
		vec2 cLodSize = vec2( textureSize( sampler, int( lod + 1.0 ) ) );
		vec2 fLodSizeInv = 1.0 / fLodSize;
		vec2 cLodSizeInv = 1.0 / cLodSize;
		vec4 fSample = bicubic( sampler, uv, vec4( fLodSizeInv, fLodSize ), floor( lod ) );
		vec4 cSample = bicubic( sampler, uv, vec4( cLodSizeInv, cLodSize ), ceil( lod ) );
		return mix( fSample, cSample, fract( lod ) );
	}
	vec3 getVolumeTransmissionRay( const in vec3 n, const in vec3 v, const in float thickness, const in float ior, const in mat4 modelMatrix ) {
		vec3 refractionVector = refract( - v, normalize( n ), 1.0 / ior );
		vec3 modelScale;
		modelScale.x = length( vec3( modelMatrix[ 0 ].xyz ) );
		modelScale.y = length( vec3( modelMatrix[ 1 ].xyz ) );
		modelScale.z = length( vec3( modelMatrix[ 2 ].xyz ) );
		return normalize( refractionVector ) * thickness * modelScale;
	}
	float applyIorToRoughness( const in float roughness, const in float ior ) {
		return roughness * clamp( ior * 2.0 - 2.0, 0.0, 1.0 );
	}
	vec4 getTransmissionSample( const in vec2 fragCoord, const in float roughness, const in float ior ) {
		float lod = log2( transmissionSamplerSize.x ) * applyIorToRoughness( roughness, ior );
		return textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );
	}
	vec3 volumeAttenuation( const in float transmissionDistance, const in vec3 attenuationColor, const in float attenuationDistance ) {
		if ( isinf( attenuationDistance ) ) {
			return vec3( 1.0 );
		} else {
			vec3 attenuationCoefficient = -log( attenuationColor ) / attenuationDistance;
			vec3 transmittance = exp( - attenuationCoefficient * transmissionDistance );			return transmittance;
		}
	}
	vec4 getIBLVolumeRefraction( const in vec3 n, const in vec3 v, const in float roughness, const in vec3 diffuseColor,
		const in vec3 specularColor, const in float specularF90, const in vec3 position, const in mat4 modelMatrix,
		const in mat4 viewMatrix, const in mat4 projMatrix, const in float dispersion, const in float ior, const in float thickness,
		const in vec3 attenuationColor, const in float attenuationDistance ) {
		vec4 transmittedLight;
		vec3 transmittance;
		#ifdef USE_DISPERSION
			float halfSpread = ( ior - 1.0 ) * 0.025 * dispersion;
			vec3 iors = vec3( ior - halfSpread, ior, ior + halfSpread );
			for ( int i = 0; i < 3; i ++ ) {
				vec3 transmissionRay = getVolumeTransmissionRay( n, v, thickness, iors[ i ], modelMatrix );
				vec3 refractedRayExit = position + transmissionRay;
				vec4 ndcPos = projMatrix * viewMatrix * vec4( refractedRayExit, 1.0 );
				vec2 refractionCoords = ndcPos.xy / ndcPos.w;
				refractionCoords += 1.0;
				refractionCoords /= 2.0;
				vec4 transmissionSample = getTransmissionSample( refractionCoords, roughness, iors[ i ] );
				transmittedLight[ i ] = transmissionSample[ i ];
				transmittedLight.a += transmissionSample.a;
				transmittance[ i ] = diffuseColor[ i ] * volumeAttenuation( length( transmissionRay ), attenuationColor, attenuationDistance )[ i ];
			}
			transmittedLight.a /= 3.0;
		#else
			vec3 transmissionRay = getVolumeTransmissionRay( n, v, thickness, ior, modelMatrix );
			vec3 refractedRayExit = position + transmissionRay;
			vec4 ndcPos = projMatrix * viewMatrix * vec4( refractedRayExit, 1.0 );
			vec2 refractionCoords = ndcPos.xy / ndcPos.w;
			refractionCoords += 1.0;
			refractionCoords /= 2.0;
			transmittedLight = getTransmissionSample( refractionCoords, roughness, ior );
			transmittance = diffuseColor * volumeAttenuation( length( transmissionRay ), attenuationColor, attenuationDistance );
		#endif
		vec3 attenuatedColor = transmittance * transmittedLight.rgb;
		vec3 F = EnvironmentBRDF( n, v, specularColor, specularF90, roughness );
		float transmittanceFactor = ( transmittance.r + transmittance.g + transmittance.b ) / 3.0;
		return vec4( ( 1.0 - F ) * attenuatedColor, 1.0 - ( 1.0 - transmittedLight.a ) * transmittanceFactor );
	}
#endif`,AS=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	varying vec2 vUv;
#endif
#ifdef USE_MAP
	varying vec2 vMapUv;
#endif
#ifdef USE_ALPHAMAP
	varying vec2 vAlphaMapUv;
#endif
#ifdef USE_LIGHTMAP
	varying vec2 vLightMapUv;
#endif
#ifdef USE_AOMAP
	varying vec2 vAoMapUv;
#endif
#ifdef USE_BUMPMAP
	varying vec2 vBumpMapUv;
#endif
#ifdef USE_NORMALMAP
	varying vec2 vNormalMapUv;
#endif
#ifdef USE_EMISSIVEMAP
	varying vec2 vEmissiveMapUv;
#endif
#ifdef USE_METALNESSMAP
	varying vec2 vMetalnessMapUv;
#endif
#ifdef USE_ROUGHNESSMAP
	varying vec2 vRoughnessMapUv;
#endif
#ifdef USE_ANISOTROPYMAP
	varying vec2 vAnisotropyMapUv;
#endif
#ifdef USE_CLEARCOATMAP
	varying vec2 vClearcoatMapUv;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	varying vec2 vClearcoatNormalMapUv;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	varying vec2 vClearcoatRoughnessMapUv;
#endif
#ifdef USE_IRIDESCENCEMAP
	varying vec2 vIridescenceMapUv;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	varying vec2 vIridescenceThicknessMapUv;
#endif
#ifdef USE_SHEEN_COLORMAP
	varying vec2 vSheenColorMapUv;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	varying vec2 vSheenRoughnessMapUv;
#endif
#ifdef USE_SPECULARMAP
	varying vec2 vSpecularMapUv;
#endif
#ifdef USE_SPECULAR_COLORMAP
	varying vec2 vSpecularColorMapUv;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	varying vec2 vSpecularIntensityMapUv;
#endif
#ifdef USE_TRANSMISSIONMAP
	uniform mat3 transmissionMapTransform;
	varying vec2 vTransmissionMapUv;
#endif
#ifdef USE_THICKNESSMAP
	uniform mat3 thicknessMapTransform;
	varying vec2 vThicknessMapUv;
#endif`,ES=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	varying vec2 vUv;
#endif
#ifdef USE_MAP
	uniform mat3 mapTransform;
	varying vec2 vMapUv;
#endif
#ifdef USE_ALPHAMAP
	uniform mat3 alphaMapTransform;
	varying vec2 vAlphaMapUv;
#endif
#ifdef USE_LIGHTMAP
	uniform mat3 lightMapTransform;
	varying vec2 vLightMapUv;
#endif
#ifdef USE_AOMAP
	uniform mat3 aoMapTransform;
	varying vec2 vAoMapUv;
#endif
#ifdef USE_BUMPMAP
	uniform mat3 bumpMapTransform;
	varying vec2 vBumpMapUv;
#endif
#ifdef USE_NORMALMAP
	uniform mat3 normalMapTransform;
	varying vec2 vNormalMapUv;
#endif
#ifdef USE_DISPLACEMENTMAP
	uniform mat3 displacementMapTransform;
	varying vec2 vDisplacementMapUv;
#endif
#ifdef USE_EMISSIVEMAP
	uniform mat3 emissiveMapTransform;
	varying vec2 vEmissiveMapUv;
#endif
#ifdef USE_METALNESSMAP
	uniform mat3 metalnessMapTransform;
	varying vec2 vMetalnessMapUv;
#endif
#ifdef USE_ROUGHNESSMAP
	uniform mat3 roughnessMapTransform;
	varying vec2 vRoughnessMapUv;
#endif
#ifdef USE_ANISOTROPYMAP
	uniform mat3 anisotropyMapTransform;
	varying vec2 vAnisotropyMapUv;
#endif
#ifdef USE_CLEARCOATMAP
	uniform mat3 clearcoatMapTransform;
	varying vec2 vClearcoatMapUv;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	uniform mat3 clearcoatNormalMapTransform;
	varying vec2 vClearcoatNormalMapUv;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	uniform mat3 clearcoatRoughnessMapTransform;
	varying vec2 vClearcoatRoughnessMapUv;
#endif
#ifdef USE_SHEEN_COLORMAP
	uniform mat3 sheenColorMapTransform;
	varying vec2 vSheenColorMapUv;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	uniform mat3 sheenRoughnessMapTransform;
	varying vec2 vSheenRoughnessMapUv;
#endif
#ifdef USE_IRIDESCENCEMAP
	uniform mat3 iridescenceMapTransform;
	varying vec2 vIridescenceMapUv;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	uniform mat3 iridescenceThicknessMapTransform;
	varying vec2 vIridescenceThicknessMapUv;
#endif
#ifdef USE_SPECULARMAP
	uniform mat3 specularMapTransform;
	varying vec2 vSpecularMapUv;
#endif
#ifdef USE_SPECULAR_COLORMAP
	uniform mat3 specularColorMapTransform;
	varying vec2 vSpecularColorMapUv;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	uniform mat3 specularIntensityMapTransform;
	varying vec2 vSpecularIntensityMapUv;
#endif
#ifdef USE_TRANSMISSIONMAP
	uniform mat3 transmissionMapTransform;
	varying vec2 vTransmissionMapUv;
#endif
#ifdef USE_THICKNESSMAP
	uniform mat3 thicknessMapTransform;
	varying vec2 vThicknessMapUv;
#endif`,CS=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	vUv = vec3( uv, 1 ).xy;
#endif
#ifdef USE_MAP
	vMapUv = ( mapTransform * vec3( MAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ALPHAMAP
	vAlphaMapUv = ( alphaMapTransform * vec3( ALPHAMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_LIGHTMAP
	vLightMapUv = ( lightMapTransform * vec3( LIGHTMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_AOMAP
	vAoMapUv = ( aoMapTransform * vec3( AOMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_BUMPMAP
	vBumpMapUv = ( bumpMapTransform * vec3( BUMPMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_NORMALMAP
	vNormalMapUv = ( normalMapTransform * vec3( NORMALMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_DISPLACEMENTMAP
	vDisplacementMapUv = ( displacementMapTransform * vec3( DISPLACEMENTMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_EMISSIVEMAP
	vEmissiveMapUv = ( emissiveMapTransform * vec3( EMISSIVEMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_METALNESSMAP
	vMetalnessMapUv = ( metalnessMapTransform * vec3( METALNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ROUGHNESSMAP
	vRoughnessMapUv = ( roughnessMapTransform * vec3( ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ANISOTROPYMAP
	vAnisotropyMapUv = ( anisotropyMapTransform * vec3( ANISOTROPYMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOATMAP
	vClearcoatMapUv = ( clearcoatMapTransform * vec3( CLEARCOATMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	vClearcoatNormalMapUv = ( clearcoatNormalMapTransform * vec3( CLEARCOAT_NORMALMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	vClearcoatRoughnessMapUv = ( clearcoatRoughnessMapTransform * vec3( CLEARCOAT_ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_IRIDESCENCEMAP
	vIridescenceMapUv = ( iridescenceMapTransform * vec3( IRIDESCENCEMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	vIridescenceThicknessMapUv = ( iridescenceThicknessMapTransform * vec3( IRIDESCENCE_THICKNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SHEEN_COLORMAP
	vSheenColorMapUv = ( sheenColorMapTransform * vec3( SHEEN_COLORMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	vSheenRoughnessMapUv = ( sheenRoughnessMapTransform * vec3( SHEEN_ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULARMAP
	vSpecularMapUv = ( specularMapTransform * vec3( SPECULARMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULAR_COLORMAP
	vSpecularColorMapUv = ( specularColorMapTransform * vec3( SPECULAR_COLORMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	vSpecularIntensityMapUv = ( specularIntensityMapTransform * vec3( SPECULAR_INTENSITYMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_TRANSMISSIONMAP
	vTransmissionMapUv = ( transmissionMapTransform * vec3( TRANSMISSIONMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_THICKNESSMAP
	vThicknessMapUv = ( thicknessMapTransform * vec3( THICKNESSMAP_UV, 1 ) ).xy;
#endif`,RS=`#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
	vec4 worldPosition = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		worldPosition = batchingMatrix * worldPosition;
	#endif
	#ifdef USE_INSTANCING
		worldPosition = instanceMatrix * worldPosition;
	#endif
	worldPosition = modelMatrix * worldPosition;
#endif`,PS=`varying vec2 vUv;
uniform mat3 uvTransform;
void main() {
	vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
	gl_Position = vec4( position.xy, 1.0, 1.0 );
}`,IS=`uniform sampler2D t2D;
uniform float backgroundIntensity;
varying vec2 vUv;
void main() {
	vec4 texColor = texture2D( t2D, vUv );
	#ifdef DECODE_VIDEO_TEXTURE
		texColor = vec4( mix( pow( texColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), texColor.rgb * 0.0773993808, vec3( lessThanEqual( texColor.rgb, vec3( 0.04045 ) ) ) ), texColor.w );
	#endif
	texColor.rgb *= backgroundIntensity;
	gl_FragColor = texColor;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,LS=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
	gl_Position.z = gl_Position.w;
}`,DS=`#ifdef ENVMAP_TYPE_CUBE
	uniform samplerCube envMap;
#elif defined( ENVMAP_TYPE_CUBE_UV )
	uniform sampler2D envMap;
#endif
uniform float backgroundBlurriness;
uniform float backgroundIntensity;
uniform mat3 backgroundRotation;
varying vec3 vWorldDirection;
#include <cube_uv_reflection_fragment>
void main() {
	#ifdef ENVMAP_TYPE_CUBE
		vec4 texColor = textureCube( envMap, backgroundRotation * vWorldDirection );
	#elif defined( ENVMAP_TYPE_CUBE_UV )
		vec4 texColor = textureCubeUV( envMap, backgroundRotation * vWorldDirection, backgroundBlurriness );
	#else
		vec4 texColor = vec4( 0.0, 0.0, 0.0, 1.0 );
	#endif
	texColor.rgb *= backgroundIntensity;
	gl_FragColor = texColor;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,NS=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
	gl_Position.z = gl_Position.w;
}`,FS=`uniform samplerCube tCube;
uniform float tFlip;
uniform float opacity;
varying vec3 vWorldDirection;
void main() {
	vec4 texColor = textureCube( tCube, vec3( tFlip * vWorldDirection.x, vWorldDirection.yz ) );
	gl_FragColor = texColor;
	gl_FragColor.a *= opacity;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,US=`#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
varying vec2 vHighPrecisionZW;
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <skinbase_vertex>
	#include <morphinstance_vertex>
	#ifdef USE_DISPLACEMENTMAP
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vHighPrecisionZW = gl_Position.zw;
}`,BS=`#if DEPTH_PACKING == 3200
	uniform float opacity;
#endif
#include <common>
#include <packing>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
varying vec2 vHighPrecisionZW;
void main() {
	vec4 diffuseColor = vec4( 1.0 );
	#include <clipping_planes_fragment>
	#if DEPTH_PACKING == 3200
		diffuseColor.a = opacity;
	#endif
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <logdepthbuf_fragment>
	#ifdef USE_REVERSED_DEPTH_BUFFER
		float fragCoordZ = vHighPrecisionZW[ 0 ] / vHighPrecisionZW[ 1 ];
	#else
		float fragCoordZ = 0.5 * vHighPrecisionZW[ 0 ] / vHighPrecisionZW[ 1 ] + 0.5;
	#endif
	#if DEPTH_PACKING == 3200
		gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );
	#elif DEPTH_PACKING == 3201
		gl_FragColor = packDepthToRGBA( fragCoordZ );
	#elif DEPTH_PACKING == 3202
		gl_FragColor = vec4( packDepthToRGB( fragCoordZ ), 1.0 );
	#elif DEPTH_PACKING == 3203
		gl_FragColor = vec4( packDepthToRG( fragCoordZ ), 0.0, 1.0 );
	#endif
}`,OS=`#define DISTANCE
varying vec3 vWorldPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <skinbase_vertex>
	#include <morphinstance_vertex>
	#ifdef USE_DISPLACEMENTMAP
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <worldpos_vertex>
	#include <clipping_planes_vertex>
	vWorldPosition = worldPosition.xyz;
}`,zS=`#define DISTANCE
uniform vec3 referencePosition;
uniform float nearDistance;
uniform float farDistance;
varying vec3 vWorldPosition;
#include <common>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( 1.0 );
	#include <clipping_planes_fragment>
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	float dist = length( vWorldPosition - referencePosition );
	dist = ( dist - nearDistance ) / ( farDistance - nearDistance );
	dist = saturate( dist );
	gl_FragColor = vec4( dist, 0.0, 0.0, 1.0 );
}`,kS=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
}`,GS=`uniform sampler2D tEquirect;
varying vec3 vWorldDirection;
#include <common>
void main() {
	vec3 direction = normalize( vWorldDirection );
	vec2 sampleUV = equirectUv( direction );
	gl_FragColor = texture2D( tEquirect, sampleUV );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,VS=`uniform float scale;
attribute float lineDistance;
varying float vLineDistance;
#include <common>
#include <uv_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	vLineDistance = scale * lineDistance;
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
}`,HS=`uniform vec3 diffuse;
uniform float opacity;
uniform float dashSize;
uniform float totalSize;
varying float vLineDistance;
#include <common>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	if ( mod( vLineDistance, totalSize ) > dashSize ) {
		discard;
	}
	vec3 outgoingLight = vec3( 0.0 );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,WS=`#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinbase_vertex>
		#include <skinnormal_vertex>
		#include <defaultnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <fog_vertex>
}`,XS=`uniform vec3 diffuse;
uniform float opacity;
#ifndef FLAT_SHADED
	varying vec3 vNormal;
#endif
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		reflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;
	#else
		reflectedLight.indirectDiffuse += vec3( 1.0 );
	#endif
	#include <aomap_fragment>
	reflectedLight.indirectDiffuse *= diffuseColor.rgb;
	vec3 outgoingLight = reflectedLight.indirectDiffuse;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,qS=`#define LAMBERT
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,YS=`#define LAMBERT
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float opacity;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <cube_uv_reflection_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <envmap_physical_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_lambert_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_lambert_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,ZS=`#define MATCAP
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <color_pars_vertex>
#include <displacementmap_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
	vViewPosition = - mvPosition.xyz;
}`,$S=`#define MATCAP
uniform vec3 diffuse;
uniform float opacity;
uniform sampler2D matcap;
varying vec3 vViewPosition;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	vec3 viewDir = normalize( vViewPosition );
	vec3 x = normalize( vec3( viewDir.z, 0.0, - viewDir.x ) );
	vec3 y = cross( viewDir, x );
	vec2 uv = vec2( dot( x, normal ), dot( y, normal ) ) * 0.495 + 0.5;
	#ifdef USE_MATCAP
		vec4 matcapColor = texture2D( matcap, uv );
	#else
		vec4 matcapColor = vec4( vec3( mix( 0.2, 0.8, uv.y ) ), 1.0 );
	#endif
	vec3 outgoingLight = diffuseColor.rgb * matcapColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,JS=`#define NORMAL
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	varying vec3 vViewPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphinstance_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	vViewPosition = - mvPosition.xyz;
#endif
}`,KS=`#define NORMAL
uniform float opacity;
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	varying vec3 vViewPosition;
#endif
#include <uv_pars_fragment>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( 0.0, 0.0, 0.0, opacity );
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	gl_FragColor = vec4( normalize( normal ) * 0.5 + 0.5, diffuseColor.a );
	#ifdef OPAQUE
		gl_FragColor.a = 1.0;
	#endif
}`,jS=`#define PHONG
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphinstance_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,QS=`#define PHONG
uniform vec3 diffuse;
uniform vec3 emissive;
uniform vec3 specular;
uniform float shininess;
uniform float opacity;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <cube_uv_reflection_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <envmap_physical_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_phong_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_phong_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular + totalEmissiveRadiance;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,eb=`#define STANDARD
varying vec3 vViewPosition;
#ifdef USE_TRANSMISSION
	varying vec3 vWorldPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
#ifdef USE_TRANSMISSION
	vWorldPosition = worldPosition.xyz;
#endif
}`,tb=`#define STANDARD
#ifdef PHYSICAL
	#define IOR
	#define USE_SPECULAR
#endif
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float roughness;
uniform float metalness;
uniform float opacity;
#ifdef IOR
	uniform float ior;
#endif
#ifdef USE_SPECULAR
	uniform float specularIntensity;
	uniform vec3 specularColor;
	#ifdef USE_SPECULAR_COLORMAP
		uniform sampler2D specularColorMap;
	#endif
	#ifdef USE_SPECULAR_INTENSITYMAP
		uniform sampler2D specularIntensityMap;
	#endif
#endif
#ifdef USE_CLEARCOAT
	uniform float clearcoat;
	uniform float clearcoatRoughness;
#endif
#ifdef USE_DISPERSION
	uniform float dispersion;
#endif
#ifdef USE_RETROREFLECTION
	uniform float retroreflectivity;
#endif
#ifdef USE_IRIDESCENCE
	uniform float iridescence;
	uniform float iridescenceIOR;
	uniform float iridescenceThicknessMinimum;
	uniform float iridescenceThicknessMaximum;
#endif
#ifdef USE_SHEEN
	uniform vec3 sheenColor;
	uniform float sheenRoughness;
	#ifdef USE_SHEEN_COLORMAP
		uniform sampler2D sheenColorMap;
	#endif
	#ifdef USE_SHEEN_ROUGHNESSMAP
		uniform sampler2D sheenRoughnessMap;
	#endif
#endif
#ifdef USE_ANISOTROPY
	uniform vec2 anisotropyVector;
	#ifdef USE_ANISOTROPYMAP
		uniform sampler2D anisotropyMap;
	#endif
#endif
varying vec3 vViewPosition;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <iridescence_fragment>
#include <cube_uv_reflection_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_physical_pars_fragment>
#include <fog_pars_fragment>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_physical_pars_fragment>
#include <transmission_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <clearcoat_pars_fragment>
#include <iridescence_pars_fragment>
#include <roughnessmap_pars_fragment>
#include <metalnessmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <roughnessmap_fragment>
	#include <metalnessmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <clearcoat_normal_fragment_begin>
	#include <clearcoat_normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_physical_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
	vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
	#include <transmission_fragment>
	vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
	#ifdef USE_SHEEN
 
		outgoingLight = outgoingLight + sheenSpecularDirect + sheenSpecularIndirect;
 
 	#endif
	#ifdef USE_CLEARCOAT
		float dotNVcc = saturate( dot( geometryClearcoatNormal, geometryViewDir ) );
		vec3 Fcc = F_Schlick( material.clearcoatF0, material.clearcoatF90, dotNVcc );
		outgoingLight = outgoingLight * ( 1.0 - material.clearcoat * Fcc ) + ( clearcoatSpecularDirect + clearcoatSpecularIndirect ) * material.clearcoat;
	#endif
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,nb=`#define TOON
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,ib=`#define TOON
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float opacity;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <gradientmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_toon_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_toon_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,rb=`uniform float size;
uniform float scale;
#include <common>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
#ifdef USE_POINTS_UV
	varying vec2 vUv;
	uniform mat3 uvTransform;
#endif
void main() {
	#ifdef USE_POINTS_UV
		vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
	#endif
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <project_vertex>
	gl_PointSize = size;
	#ifdef USE_SIZEATTENUATION
		bool isPerspective = isPerspectiveMatrix( projectionMatrix );
		if ( isPerspective ) gl_PointSize *= ( scale / - mvPosition.z );
	#endif
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <worldpos_vertex>
	#include <fog_vertex>
}`,sb=`uniform vec3 diffuse;
uniform float opacity;
#include <common>
#include <color_pars_fragment>
#include <map_particle_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	vec3 outgoingLight = vec3( 0.0 );
	#include <logdepthbuf_fragment>
	#include <map_particle_fragment>
	#include <color_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,ob=`#include <common>
#include <batching_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <shadowmap_pars_vertex>
void main() {
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphinstance_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,ab=`uniform vec3 color;
uniform float opacity;
#include <common>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <logdepthbuf_pars_fragment>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
void main() {
	#include <logdepthbuf_fragment>
	gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,lb=`uniform float rotation;
uniform vec2 center;
#include <common>
#include <uv_pars_vertex>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	vec4 mvPosition = modelViewMatrix[ 3 ];
	vec2 scale = vec2( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ) );
	#ifndef USE_SIZEATTENUATION
		bool isPerspective = isPerspectiveMatrix( projectionMatrix );
		if ( isPerspective ) scale *= - mvPosition.z;
	#endif
	vec2 alignedPosition = ( position.xy - ( center - vec2( 0.5 ) ) ) * scale;
	vec2 rotatedPosition;
	rotatedPosition.x = cos( rotation ) * alignedPosition.x - sin( rotation ) * alignedPosition.y;
	rotatedPosition.y = sin( rotation ) * alignedPosition.x + cos( rotation ) * alignedPosition.y;
	mvPosition.xy += rotatedPosition;
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
}`,cb=`uniform vec3 diffuse;
uniform float opacity;
#include <common>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	vec3 outgoingLight = vec3( 0.0 );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}`,gt={alphahash_fragment:P1,alphahash_pars_fragment:I1,alphamap_fragment:L1,alphamap_pars_fragment:D1,alphatest_fragment:N1,alphatest_pars_fragment:F1,aomap_fragment:U1,aomap_pars_fragment:B1,batching_pars_vertex:O1,batching_vertex:z1,begin_vertex:k1,beginnormal_vertex:G1,bsdfs:V1,iridescence_fragment:H1,bumpmap_pars_fragment:W1,clipping_planes_fragment:X1,clipping_planes_pars_fragment:q1,clipping_planes_pars_vertex:Y1,clipping_planes_vertex:Z1,color_fragment:$1,color_pars_fragment:J1,color_pars_vertex:K1,color_vertex:j1,common:Q1,cube_uv_reflection_fragment:eM,defaultnormal_vertex:tM,displacementmap_pars_vertex:nM,displacementmap_vertex:iM,emissivemap_fragment:rM,emissivemap_pars_fragment:sM,colorspace_fragment:oM,colorspace_pars_fragment:aM,envmap_fragment:lM,envmap_common_pars_fragment:cM,envmap_pars_fragment:uM,envmap_pars_vertex:hM,envmap_physical_pars_fragment:SM,envmap_vertex:fM,fog_vertex:dM,fog_pars_vertex:pM,fog_fragment:mM,fog_pars_fragment:gM,gradientmap_pars_fragment:vM,lightmap_pars_fragment:xM,lights_lambert_fragment:yM,lights_lambert_pars_fragment:_M,lights_pars_begin:MM,lights_toon_fragment:bM,lights_toon_pars_fragment:wM,lights_phong_fragment:TM,lights_phong_pars_fragment:AM,lights_physical_fragment:EM,lights_physical_pars_fragment:CM,lights_fragment_begin:RM,lights_fragment_maps:PM,lights_fragment_end:IM,lightprobes_pars_fragment:LM,logdepthbuf_fragment:DM,logdepthbuf_pars_fragment:NM,logdepthbuf_pars_vertex:FM,logdepthbuf_vertex:UM,map_fragment:BM,map_pars_fragment:OM,map_particle_fragment:zM,map_particle_pars_fragment:kM,metalnessmap_fragment:GM,metalnessmap_pars_fragment:VM,morphinstance_vertex:HM,morphcolor_vertex:WM,morphnormal_vertex:XM,morphtarget_pars_vertex:qM,morphtarget_vertex:YM,normal_fragment_begin:ZM,normal_fragment_maps:$M,normal_pars_fragment:JM,normal_pars_vertex:KM,normal_vertex:jM,normalmap_pars_fragment:QM,clearcoat_normal_fragment_begin:eS,clearcoat_normal_fragment_maps:tS,clearcoat_pars_fragment:nS,iridescence_pars_fragment:iS,opaque_fragment:rS,packing:sS,premultiplied_alpha_fragment:oS,project_vertex:aS,dithering_fragment:lS,dithering_pars_fragment:cS,roughnessmap_fragment:uS,roughnessmap_pars_fragment:hS,shadowmap_pars_fragment:fS,shadowmap_pars_vertex:dS,shadowmap_vertex:pS,shadowmask_pars_fragment:mS,skinbase_vertex:gS,skinning_pars_vertex:vS,skinning_vertex:xS,skinnormal_vertex:yS,specularmap_fragment:_S,specularmap_pars_fragment:MS,tonemapping_fragment:SS,tonemapping_pars_fragment:bS,transmission_fragment:wS,transmission_pars_fragment:TS,uv_pars_fragment:AS,uv_pars_vertex:ES,uv_vertex:CS,worldpos_vertex:RS,background_vert:PS,background_frag:IS,backgroundCube_vert:LS,backgroundCube_frag:DS,cube_vert:NS,cube_frag:FS,depth_vert:US,depth_frag:BS,distance_vert:OS,distance_frag:zS,equirect_vert:kS,equirect_frag:GS,linedashed_vert:VS,linedashed_frag:HS,meshbasic_vert:WS,meshbasic_frag:XS,meshlambert_vert:qS,meshlambert_frag:YS,meshmatcap_vert:ZS,meshmatcap_frag:$S,meshnormal_vert:JS,meshnormal_frag:KS,meshphong_vert:jS,meshphong_frag:QS,meshphysical_vert:eb,meshphysical_frag:tb,meshtoon_vert:nb,meshtoon_frag:ib,points_vert:rb,points_frag:sb,shadow_vert:ob,shadow_frag:ab,sprite_vert:lb,sprite_frag:cb},Xe={common:{diffuse:{value:new be(16777215)},opacity:{value:1},map:{value:null},mapTransform:{value:new ft},alphaMap:{value:null},alphaMapTransform:{value:new ft},alphaTest:{value:0}},specularmap:{specularMap:{value:null},specularMapTransform:{value:new ft}},envmap:{envMap:{value:null},envMapRotation:{value:new ft},reflectivity:{value:1},ior:{value:1.5},refractionRatio:{value:.98},dfgLUT:{value:null}},aomap:{aoMap:{value:null},aoMapIntensity:{value:1},aoMapTransform:{value:new ft}},lightmap:{lightMap:{value:null},lightMapIntensity:{value:1},lightMapTransform:{value:new ft}},bumpmap:{bumpMap:{value:null},bumpMapTransform:{value:new ft},bumpScale:{value:1}},normalmap:{normalMap:{value:null},normalMapTransform:{value:new ft},normalScale:{value:new he(1,1)}},displacementmap:{displacementMap:{value:null},displacementMapTransform:{value:new ft},displacementScale:{value:1},displacementBias:{value:0}},emissivemap:{emissiveMap:{value:null},emissiveMapTransform:{value:new ft}},metalnessmap:{metalnessMap:{value:null},metalnessMapTransform:{value:new ft}},roughnessmap:{roughnessMap:{value:null},roughnessMapTransform:{value:new ft}},gradientmap:{gradientMap:{value:null}},fog:{fogDensity:{value:25e-5},fogNear:{value:1},fogFar:{value:2e3},fogColor:{value:new be(16777215)}},lights:{ambientLightColor:{value:[]},lightProbe:{value:[]},sunLights:{value:[],properties:{direction:{},color:{}}},sunLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},sunShadowMatrix:{value:[]},sunShadowCascade:{value:[]},directionalLights:{value:[],properties:{direction:{},color:{}}},directionalLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},directionalShadowMatrix:{value:[]},spotLights:{value:[],properties:{color:{},position:{},direction:{},distance:{},coneCos:{},penumbraCos:{},decay:{}}},spotLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},spotLightMap:{value:[]},spotLightMatrix:{value:[]},pointLights:{value:[],properties:{color:{},position:{},decay:{},distance:{}}},pointLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{},shadowCameraNear:{},shadowCameraFar:{}}},pointShadowMatrix:{value:[]},hemisphereLights:{value:[],properties:{direction:{},skyColor:{},groundColor:{}}},rectAreaLights:{value:[],properties:{color:{},position:{},width:{},height:{}}},ltc_1:{value:null},ltc_2:{value:null},probesSH:{value:null},probesMin:{value:new R},probesMax:{value:new R},probesResolution:{value:new R}},points:{diffuse:{value:new be(16777215)},opacity:{value:1},size:{value:1},scale:{value:1},map:{value:null},alphaMap:{value:null},alphaMapTransform:{value:new ft},alphaTest:{value:0},uvTransform:{value:new ft}},sprite:{diffuse:{value:new be(16777215)},opacity:{value:1},center:{value:new he(.5,.5)},rotation:{value:0},map:{value:null},mapTransform:{value:new ft},alphaMap:{value:null},alphaMapTransform:{value:new ft},alphaTest:{value:0}}},Gi={basic:{uniforms:Ln([Xe.common,Xe.specularmap,Xe.envmap,Xe.aomap,Xe.lightmap,Xe.fog]),vertexShader:gt.meshbasic_vert,fragmentShader:gt.meshbasic_frag},lambert:{uniforms:Ln([Xe.common,Xe.specularmap,Xe.envmap,Xe.aomap,Xe.lightmap,Xe.emissivemap,Xe.bumpmap,Xe.normalmap,Xe.displacementmap,Xe.fog,Xe.lights,{emissive:{value:new be(0)},envMapIntensity:{value:1}}]),vertexShader:gt.meshlambert_vert,fragmentShader:gt.meshlambert_frag},phong:{uniforms:Ln([Xe.common,Xe.specularmap,Xe.envmap,Xe.aomap,Xe.lightmap,Xe.emissivemap,Xe.bumpmap,Xe.normalmap,Xe.displacementmap,Xe.fog,Xe.lights,{emissive:{value:new be(0)},specular:{value:new be(1118481)},shininess:{value:30},envMapIntensity:{value:1}}]),vertexShader:gt.meshphong_vert,fragmentShader:gt.meshphong_frag},standard:{uniforms:Ln([Xe.common,Xe.envmap,Xe.aomap,Xe.lightmap,Xe.emissivemap,Xe.bumpmap,Xe.normalmap,Xe.displacementmap,Xe.roughnessmap,Xe.metalnessmap,Xe.fog,Xe.lights,{emissive:{value:new be(0)},roughness:{value:1},metalness:{value:0},envMapIntensity:{value:1}}]),vertexShader:gt.meshphysical_vert,fragmentShader:gt.meshphysical_frag},toon:{uniforms:Ln([Xe.common,Xe.aomap,Xe.lightmap,Xe.emissivemap,Xe.bumpmap,Xe.normalmap,Xe.displacementmap,Xe.gradientmap,Xe.fog,Xe.lights,{emissive:{value:new be(0)}}]),vertexShader:gt.meshtoon_vert,fragmentShader:gt.meshtoon_frag},matcap:{uniforms:Ln([Xe.common,Xe.bumpmap,Xe.normalmap,Xe.displacementmap,Xe.fog,{matcap:{value:null}}]),vertexShader:gt.meshmatcap_vert,fragmentShader:gt.meshmatcap_frag},points:{uniforms:Ln([Xe.points,Xe.fog]),vertexShader:gt.points_vert,fragmentShader:gt.points_frag},dashed:{uniforms:Ln([Xe.common,Xe.fog,{scale:{value:1},dashSize:{value:1},totalSize:{value:2}}]),vertexShader:gt.linedashed_vert,fragmentShader:gt.linedashed_frag},depth:{uniforms:Ln([Xe.common,Xe.displacementmap]),vertexShader:gt.depth_vert,fragmentShader:gt.depth_frag},normal:{uniforms:Ln([Xe.common,Xe.bumpmap,Xe.normalmap,Xe.displacementmap,{opacity:{value:1}}]),vertexShader:gt.meshnormal_vert,fragmentShader:gt.meshnormal_frag},sprite:{uniforms:Ln([Xe.sprite,Xe.fog]),vertexShader:gt.sprite_vert,fragmentShader:gt.sprite_frag},background:{uniforms:{uvTransform:{value:new ft},t2D:{value:null},backgroundIntensity:{value:1}},vertexShader:gt.background_vert,fragmentShader:gt.background_frag},backgroundCube:{uniforms:{envMap:{value:null},backgroundBlurriness:{value:0},backgroundIntensity:{value:1},backgroundRotation:{value:new ft}},vertexShader:gt.backgroundCube_vert,fragmentShader:gt.backgroundCube_frag},cube:{uniforms:{tCube:{value:null},tFlip:{value:-1},opacity:{value:1}},vertexShader:gt.cube_vert,fragmentShader:gt.cube_frag},equirect:{uniforms:{tEquirect:{value:null}},vertexShader:gt.equirect_vert,fragmentShader:gt.equirect_frag},distance:{uniforms:Ln([Xe.common,Xe.displacementmap,{referencePosition:{value:new R},nearDistance:{value:1},farDistance:{value:1e3}}]),vertexShader:gt.distance_vert,fragmentShader:gt.distance_frag},shadow:{uniforms:Ln([Xe.lights,Xe.fog,{color:{value:new be(0)},opacity:{value:1}}]),vertexShader:gt.shadow_vert,fragmentShader:gt.shadow_frag}};Gi.physical={uniforms:Ln([Gi.standard.uniforms,{clearcoat:{value:0},clearcoatMap:{value:null},clearcoatMapTransform:{value:new ft},clearcoatNormalMap:{value:null},clearcoatNormalMapTransform:{value:new ft},clearcoatNormalScale:{value:new he(1,1)},clearcoatRoughness:{value:0},clearcoatRoughnessMap:{value:null},clearcoatRoughnessMapTransform:{value:new ft},dispersion:{value:0},retroreflectivity:{value:0},iridescence:{value:0},iridescenceMap:{value:null},iridescenceMapTransform:{value:new ft},iridescenceIOR:{value:1.3},iridescenceThicknessMinimum:{value:100},iridescenceThicknessMaximum:{value:400},iridescenceThicknessMap:{value:null},iridescenceThicknessMapTransform:{value:new ft},sheen:{value:0},sheenColor:{value:new be(0)},sheenColorMap:{value:null},sheenColorMapTransform:{value:new ft},sheenRoughness:{value:1},sheenRoughnessMap:{value:null},sheenRoughnessMapTransform:{value:new ft},transmission:{value:0},transmissionMap:{value:null},transmissionMapTransform:{value:new ft},transmissionSamplerSize:{value:new he},transmissionSamplerMap:{value:null},thickness:{value:0},thicknessMap:{value:null},thicknessMapTransform:{value:new ft},attenuationDistance:{value:0},attenuationColor:{value:new be(0)},specularColor:{value:new be(1,1,1)},specularColorMap:{value:null},specularColorMapTransform:{value:new ft},specularIntensity:{value:1},specularIntensityMap:{value:null},specularIntensityMapTransform:{value:new ft},anisotropyVector:{value:new he},anisotropyMap:{value:null},anisotropyMapTransform:{value:new ft}}]),vertexShader:gt.meshphysical_vert,fragmentShader:gt.meshphysical_frag};var Kf={r:0,b:0,g:0},ub=new it,ax=new ft;ax.set(-1,0,0,0,1,0,0,0,1);function hb(i,e,t,n,r,s){let o=new be(0),a=r===!0?0:1,l,c,u=null,f=0,h=null;function d(y){let _=y.isScene===!0?y.background:null;if(_&&_.isTexture){let x=y.backgroundBlurriness>0;_=e.get(_,x)}return _}function p(y){let _=!1,x=d(y);x===null?g(o,a):x&&x.isColor&&(g(x,1),_=!0);let S=i.xr.getEnvironmentBlendMode();S==="additive"?t.buffers.color.setClear(0,0,0,1,s):S==="alpha-blend"&&t.buffers.color.setClear(0,0,0,0,s),(i.autoClear||_)&&(t.buffers.depth.setTest(!0),t.buffers.depth.setMask(!0),t.buffers.color.setMask(!0),i.clear(i.autoClearColor,i.autoClearDepth,i.autoClearStencil))}function v(y,_){let x=d(_);x&&(x.isCubeTexture||x.mapping===Zs)?(c===void 0&&(c=new at(new In(1,1,1),new Lt({name:"BackgroundCubeMaterial",uniforms:Qs(Gi.backgroundCube.uniforms),vertexShader:Gi.backgroundCube.vertexShader,fragmentShader:Gi.backgroundCube.fragmentShader,side:gn,depthTest:!1,depthWrite:!1,fog:!1,allowOverride:!1})),c.geometry.deleteAttribute("normal"),c.geometry.deleteAttribute("uv"),c.onBeforeRender=function(S,b,E){this.matrixWorld.copyPosition(E.matrixWorld)},Object.defineProperty(c.material,"envMap",{get:function(){return this.uniforms.envMap.value}}),n.update(c)),c.material.uniforms.envMap.value=x,c.material.uniforms.backgroundBlurriness.value=_.backgroundBlurriness,c.material.uniforms.backgroundIntensity.value=_.backgroundIntensity,c.material.uniforms.backgroundRotation.value.setFromMatrix4(ub.makeRotationFromEuler(_.backgroundRotation)).transpose(),x.isCubeTexture&&x.isRenderTargetTexture===!1&&c.material.uniforms.backgroundRotation.value.premultiply(ax),c.material.toneMapped=vt.getTransfer(x.colorSpace)!==bt,(u!==x||f!==x.version||h!==i.toneMapping)&&(c.material.needsUpdate=!0,u=x,f=x.version,h=i.toneMapping),c.layers.enableAll(),y.unshift(c,c.geometry,c.material,0,0,null)):x&&x.isTexture&&(l===void 0&&(l=new at(new ji(2,2),new Lt({name:"BackgroundMaterial",uniforms:Qs(Gi.background.uniforms),vertexShader:Gi.background.vertexShader,fragmentShader:Gi.background.fragmentShader,side:Er,depthTest:!1,depthWrite:!1,fog:!1,allowOverride:!1})),l.geometry.deleteAttribute("normal"),Object.defineProperty(l.material,"map",{get:function(){return this.uniforms.t2D.value}}),n.update(l)),l.material.uniforms.t2D.value=x,l.material.uniforms.backgroundIntensity.value=_.backgroundIntensity,l.material.toneMapped=vt.getTransfer(x.colorSpace)!==bt,x.matrixAutoUpdate===!0&&x.updateMatrix(),l.material.uniforms.uvTransform.value.copy(x.matrix),(u!==x||f!==x.version||h!==i.toneMapping)&&(l.material.needsUpdate=!0,u=x,f=x.version,h=i.toneMapping),l.layers.enableAll(),y.unshift(l,l.geometry,l.material,0,0,null))}function g(y,_){y.getRGB(Kf,gm(i)),t.buffers.color.setClear(Kf.r,Kf.g,Kf.b,_,s)}function m(){c!==void 0&&(c.geometry.dispose(),c.material.dispose(),c=void 0),l!==void 0&&(l.geometry.dispose(),l.material.dispose(),l=void 0)}return{getClearColor:function(){return o},setClearColor:function(y,_=1){o.set(y),a=_,g(o,a)},getClearAlpha:function(){return a},setClearAlpha:function(y){a=y,g(o,a)},render:p,addToRenderList:v,dispose:m}}function fb(i,e){let t=i.getParameter(i.MAX_VERTEX_ATTRIBS),n={},r=h(null),s=r,o=!1;function a(I,D,B,F,L){let U=!1,X=f(I,F,B,D);s!==X&&(s=X,c(s.object)),U=d(I,F,B,L),U&&p(I,F,B,L),L!==null&&e.update(L,i.ELEMENT_ARRAY_BUFFER),(U||o)&&(o=!1,x(I,D,B,F),L!==null&&i.bindBuffer(i.ELEMENT_ARRAY_BUFFER,e.get(L).buffer))}function l(){return i.createVertexArray()}function c(I){return i.bindVertexArray(I)}function u(I){return i.deleteVertexArray(I)}function f(I,D,B,F){let L=F.wireframe===!0,U=n[D.id];U===void 0&&(U={},n[D.id]=U);let X=I.isInstancedMesh===!0?I.id:0,te=U[X];te===void 0&&(te={},U[X]=te);let Z=te[B.id];Z===void 0&&(Z={},te[B.id]=Z);let K=Z[L];return K===void 0&&(K=h(l()),Z[L]=K),K}function h(I){let D=[],B=[],F=[];for(let L=0;L<t;L++)D[L]=0,B[L]=0,F[L]=0;return{geometry:null,program:null,wireframe:!1,newAttributes:D,enabledAttributes:B,attributeDivisors:F,object:I,attributes:{},index:null}}function d(I,D,B,F){let L=s.attributes,U=D.attributes,X=0,te=B.getAttributes();for(let Z in te)if(te[Z].location>=0){let j=L[Z],ne=U[Z];if(ne===void 0&&(Z==="instanceMatrix"&&I.instanceMatrix&&(ne=I.instanceMatrix),Z==="instanceColor"&&I.instanceColor&&(ne=I.instanceColor)),j===void 0||j.attribute!==ne||ne&&j.data!==ne.data)return!0;X++}return s.attributesNum!==X||s.index!==F}function p(I,D,B,F){let L={},U=D.attributes,X=0,te=B.getAttributes();for(let Z in te)if(te[Z].location>=0){let j=U[Z];j===void 0&&(Z==="instanceMatrix"&&I.instanceMatrix&&(j=I.instanceMatrix),Z==="instanceColor"&&I.instanceColor&&(j=I.instanceColor));let ne={};ne.attribute=j,j&&j.data&&(ne.data=j.data),L[Z]=ne,X++}s.attributes=L,s.attributesNum=X,s.index=F}function v(){let I=s.newAttributes;for(let D=0,B=I.length;D<B;D++)I[D]=0}function g(I){m(I,0)}function m(I,D){let B=s.newAttributes,F=s.enabledAttributes,L=s.attributeDivisors;B[I]=1,F[I]===0&&(i.enableVertexAttribArray(I),F[I]=1),L[I]!==D&&(i.vertexAttribDivisor(I,D),L[I]=D)}function y(){let I=s.newAttributes,D=s.enabledAttributes;for(let B=0,F=D.length;B<F;B++)D[B]!==I[B]&&(i.disableVertexAttribArray(B),D[B]=0)}function _(I,D,B,F,L,U,X){X===!0?i.vertexAttribIPointer(I,D,B,L,U):i.vertexAttribPointer(I,D,B,F,L,U)}function x(I,D,B,F){v();let L=F.attributes,U=B.getAttributes(),X=D.defaultAttributeValues;for(let te in U){let Z=U[te];if(Z.location>=0){let K=L[te];if(K===void 0&&(te==="instanceMatrix"&&I.instanceMatrix&&(K=I.instanceMatrix),te==="instanceColor"&&I.instanceColor&&(K=I.instanceColor)),K!==void 0){let j=K.normalized,ne=K.itemSize,ie=e.get(K);if(ie===void 0)continue;let We=ie.buffer,Fe=ie.type,Ye=ie.bytesPerElement,$=Fe===i.INT||Fe===i.UNSIGNED_INT||K.gpuType===bc;if(K.isInterleavedBufferAttribute){let oe=K.data,Ce=oe.stride,He=K.offset;if(oe.isInstancedInterleavedBuffer){for(let Ee=0;Ee<Z.locationSize;Ee++)m(Z.location+Ee,oe.meshPerAttribute);I.isInstancedMesh!==!0&&F._maxInstanceCount===void 0&&(F._maxInstanceCount=oe.meshPerAttribute*oe.count)}else for(let Ee=0;Ee<Z.locationSize;Ee++)g(Z.location+Ee);i.bindBuffer(i.ARRAY_BUFFER,We);for(let Ee=0;Ee<Z.locationSize;Ee++)_(Z.location+Ee,ne/Z.locationSize,Fe,j,Ce*Ye,(He+ne/Z.locationSize*Ee)*Ye,$)}else{if(K.isInstancedBufferAttribute){for(let oe=0;oe<Z.locationSize;oe++)m(Z.location+oe,K.meshPerAttribute);I.isInstancedMesh!==!0&&F._maxInstanceCount===void 0&&(F._maxInstanceCount=K.meshPerAttribute*K.count)}else for(let oe=0;oe<Z.locationSize;oe++)g(Z.location+oe);i.bindBuffer(i.ARRAY_BUFFER,We);for(let oe=0;oe<Z.locationSize;oe++)_(Z.location+oe,ne/Z.locationSize,Fe,j,ne*Ye,ne/Z.locationSize*oe*Ye,$)}}else if(X!==void 0){let j=X[te];if(j!==void 0)switch(j.length){case 2:i.vertexAttrib2fv(Z.location,j);break;case 3:i.vertexAttrib3fv(Z.location,j);break;case 4:i.vertexAttrib4fv(Z.location,j);break;default:i.vertexAttrib1fv(Z.location,j)}}}}y()}function S(){T();for(let I in n){let D=n[I];for(let B in D){let F=D[B];for(let L in F){let U=F[L];for(let X in U)u(U[X].object),delete U[X];delete F[L]}}delete n[I]}}function b(I){if(n[I.id]===void 0)return;let D=n[I.id];for(let B in D){let F=D[B];for(let L in F){let U=F[L];for(let X in U)u(U[X].object),delete U[X];delete F[L]}}delete n[I.id]}function E(I){for(let D in n){let B=n[D];for(let F in B){let L=B[F];if(L[I.id]===void 0)continue;let U=L[I.id];for(let X in U)u(U[X].object),delete U[X];delete L[I.id]}}}function M(I){for(let D in n){let B=n[D],F=I.isInstancedMesh===!0?I.id:0,L=B[F];if(L!==void 0){for(let U in L){let X=L[U];for(let te in X)u(X[te].object),delete X[te];delete L[U]}delete B[F],Object.keys(B).length===0&&delete n[D]}}}function T(){A(),o=!0,s!==r&&(s=r,c(s.object))}function A(){r.geometry=null,r.program=null,r.wireframe=!1}return{setup:a,reset:T,resetDefaultState:A,dispose:S,releaseStatesOfGeometry:b,releaseStatesOfObject:M,releaseStatesOfProgram:E,initAttributes:v,enableAttribute:g,disableUnusedAttributes:y}}function db(i,e,t){let n;function r(l){n=l}function s(l,c){i.drawArrays(n,l,c),t.update(c,n,1)}function o(l,c,u){u!==0&&(i.drawArraysInstanced(n,l,c,u),t.update(c,n,u))}function a(l,c,u){if(u===0)return;e.get("WEBGL_multi_draw").multiDrawArraysWEBGL(n,l,0,c,0,u);let h=0;for(let d=0;d<u;d++)h+=c[d];t.update(h,n,1)}this.setMode=r,this.render=s,this.renderInstances=o,this.renderMultiDraw=a}function pb(i,e,t,n){let r;function s(){if(r!==void 0)return r;if(e.has("EXT_texture_filter_anisotropic")===!0){let E=e.get("EXT_texture_filter_anisotropic");r=i.getParameter(E.MAX_TEXTURE_MAX_ANISOTROPY_EXT)}else r=0;return r}function o(E){return!(E!==Pn&&n.convert(E)!==i.getParameter(i.IMPLEMENTATION_COLOR_READ_FORMAT))}function a(E){let M=E===ln&&(e.has("EXT_color_buffer_half_float")||e.has("EXT_color_buffer_float"));return!(E!==Xn&&E!==Rn&&!M&&n.convert(E)!==i.getParameter(i.IMPLEMENTATION_COLOR_READ_TYPE))}function l(E){if(E==="highp"){if(i.getShaderPrecisionFormat(i.VERTEX_SHADER,i.HIGH_FLOAT).precision>0&&i.getShaderPrecisionFormat(i.FRAGMENT_SHADER,i.HIGH_FLOAT).precision>0)return"highp";E="mediump"}return E==="mediump"&&i.getShaderPrecisionFormat(i.VERTEX_SHADER,i.MEDIUM_FLOAT).precision>0&&i.getShaderPrecisionFormat(i.FRAGMENT_SHADER,i.MEDIUM_FLOAT).precision>0?"mediump":"lowp"}let c=t.precision!==void 0?t.precision:"highp",u=l(c);u!==c&&(Ge("WebGLRenderer:",c,"not supported, using",u,"instead."),c=u);let f=t.logarithmicDepthBuffer===!0,h=t.reversedDepthBuffer===!0&&e.has("EXT_clip_control");t.reversedDepthBuffer===!0&&h===!1&&Ge("WebGLRenderer: Unable to use reversed depth buffer due to missing EXT_clip_control extension. Fallback to default depth buffer.");let d=i.getParameter(i.MAX_TEXTURE_IMAGE_UNITS),p=i.getParameter(i.MAX_VERTEX_TEXTURE_IMAGE_UNITS),v=i.getParameter(i.MAX_TEXTURE_SIZE),g=i.getParameter(i.MAX_CUBE_MAP_TEXTURE_SIZE),m=i.getParameter(i.MAX_VERTEX_ATTRIBS),y=i.getParameter(i.MAX_VERTEX_UNIFORM_VECTORS),_=i.getParameter(i.MAX_VARYING_VECTORS),x=i.getParameter(i.MAX_FRAGMENT_UNIFORM_VECTORS),S=i.getParameter(i.MAX_SAMPLES),b=i.getParameter(i.SAMPLES);return{isWebGL2:!0,getMaxAnisotropy:s,getMaxPrecision:l,textureFormatReadable:o,textureTypeReadable:a,precision:c,logarithmicDepthBuffer:f,reversedDepthBuffer:h,maxTextures:d,maxVertexTextures:p,maxTextureSize:v,maxCubemapSize:g,maxAttributes:m,maxVertexUniforms:y,maxVaryings:_,maxFragmentUniforms:x,maxSamples:S,samples:b}}function mb(i){let e=this,t=null,n=0,r=!1,s=!1,o=new Mi,a=new ft,l={value:null,needsUpdate:!1};this.uniform=l,this.numPlanes=0,this.numIntersection=0,this.init=function(f,h){let d=f.length!==0||h||n!==0||r;return r=h,n=f.length,d},this.beginShadows=function(){s=!0,u(null)},this.endShadows=function(){s=!1},this.setGlobalState=function(f,h){t=u(f,h,0)},this.setState=function(f,h,d){let p=f.clippingPlanes,v=f.clipIntersection,g=f.clipShadows,m=i.get(f);if(!r||p===null||p.length===0||s&&!g)s?u(null):c();else{let y=s?0:n,_=y*4,x=m.clippingState||null;l.value=x,x=u(p,h,_,d);for(let S=0;S!==_;++S)x[S]=t[S];m.clippingState=x,this.numIntersection=v?this.numPlanes:0,this.numPlanes+=y}};function c(){l.value!==t&&(l.value=t,l.needsUpdate=n>0),e.numPlanes=n,e.numIntersection=0}function u(f,h,d,p){let v=f!==null?f.length:0,g=null;if(v!==0){if(g=l.value,p!==!0||g===null){let m=d+v*4,y=h.matrixWorldInverse;a.getNormalMatrix(y),(g===null||g.length<m)&&(g=new Float32Array(m));for(let _=0,x=d;_!==v;++_,x+=4)o.copy(f[_]).applyMatrix4(y,a),o.normal.toArray(g,x),g[x+3]=o.constant}l.value=g,l.needsUpdate=!0}return e.numPlanes=v,e.numIntersection=0,g}}var Pa=4,gb=6,vb=20,xb=256,cu=new tr,zv=new be,Tm=null,Am=0,Em=0,Cm=!1,yb=new R,eo=new R,to=class{constructor(e){this._renderer=e,this._pingPongRenderTarget=null,this._lodMax=0,this._cubeSize=0,this._sizeLods=[],this._lodMeshes=[],this._backgroundBox=null,this._cubemapMaterial=null,this._equirectMaterial=null,this._blurMaterial=null,this._ggxMaterial=null}fromScene(e,t=0,n=.1,r=100,s={}){let{size:o=256,position:a=yb}=s;Tm=this._renderer.getRenderTarget(),Am=this._renderer.getActiveCubeFace(),Em=this._renderer.getActiveMipmapLevel(),Cm=this._renderer.xr.enabled,this._renderer.xr.enabled=!1,this._setSize(o);let l=this._allocateTargets();return l.depthBuffer=!0,this._sceneToCubeUV(e,n,r,l,a),t>0&&this._blur(l,0,0,t),this._applyPMREM(l),this._cleanup(l),l}fromEquirectangular(e,t=null){return this._fromTexture(e,t)}fromCubemap(e,t=null){return this._fromTexture(e,t)}compileCubemapShader(){this._cubemapMaterial===null&&(this._cubemapMaterial=Vv(),this._compileMaterial(this._cubemapMaterial))}compileEquirectangularShader(){this._equirectMaterial===null&&(this._equirectMaterial=Gv(),this._compileMaterial(this._equirectMaterial))}dispose(){this._dispose(),this._cubemapMaterial!==null&&this._cubemapMaterial.dispose(),this._equirectMaterial!==null&&this._equirectMaterial.dispose(),this._backgroundBox!==null&&(this._backgroundBox.geometry.dispose(),this._backgroundBox.material.dispose())}_setSize(e){this._lodMax=Math.floor(Math.log2(e)),this._cubeSize=Math.pow(2,this._lodMax)}_dispose(){this._blurMaterial!==null&&this._blurMaterial.dispose(),this._ggxMaterial!==null&&this._ggxMaterial.dispose(),this._pingPongRenderTarget!==null&&this._pingPongRenderTarget.dispose();for(let e=0;e<this._lodMeshes.length;e++)this._lodMeshes[e].geometry.dispose()}_cleanup(e){this._renderer.setRenderTarget(Tm,Am,Em),this._renderer.xr.enabled=Cm,e.scissorTest=!1,Ra(e,0,0,e.width,e.height)}_fromTexture(e,t){e.mapping===zi||e.mapping===Rr?this._setSize(e.image.length===0?16:e.image[0].width||e.image[0].image.width):this._setSize(e.image.width/4),Tm=this._renderer.getRenderTarget(),Am=this._renderer.getActiveCubeFace(),Em=this._renderer.getActiveMipmapLevel(),Cm=this._renderer.xr.enabled,this._renderer.xr.enabled=!1;let n=t||this._allocateTargets();return this._textureToCubeUV(e,n),this._applyPMREM(n),this._cleanup(n),n}_allocateTargets(){let e=3*Math.max(this._cubeSize,112),t=4*this._cubeSize,n={magFilter:zt,minFilter:zt,generateMipmaps:!1,type:ln,format:Pn,colorSpace:Oo,depthBuffer:!1},r=kv(e,t,n);if(this._pingPongRenderTarget===null||this._pingPongRenderTarget.width!==e||this._pingPongRenderTarget.height!==t){this._pingPongRenderTarget!==null&&this._dispose(),this._pingPongRenderTarget=kv(e,t,n);let{_lodMax:s}=this;({lodMeshes:this._lodMeshes,sizeLods:this._sizeLods}=_b(s)),this._blurMaterial=Sb(s,e,t),this._ggxMaterial=Mb(s,e,t)}return r}_compileMaterial(e){let t=new at(new et,e);this._renderer.compile(t,cu)}_sceneToCubeUV(e,t,n,r,s){let l=new Ft(90,1,t,n),c=[1,-1,1,1,1,1],u=[1,1,1,-1,-1,-1],f=this._renderer,h=f.autoClear,d=f.toneMapping;f.getClearColor(zv),f.toneMapping=Mn,f.autoClear=!1,f.state.buffers.depth.getReversed()&&(f.setRenderTarget(r),f.clearDepth(),f.setRenderTarget(null)),this._backgroundBox===null&&(this._backgroundBox=new at(new In,new Hn({name:"PMREM.Background",side:gn,depthWrite:!1,depthTest:!1})));let v=this._backgroundBox,g=v.material,m=!1,y=e.background;y?y.isColor&&(g.color.copy(y),e.background=null,m=!0):(g.color.copy(zv),m=!0);for(let _=0;_<6;_++){let x=_%3;x===0?(l.up.set(0,c[_],0),l.position.set(s.x,s.y,s.z),l.lookAt(s.x+u[_],s.y,s.z)):x===1?(l.up.set(0,0,c[_]),l.position.set(s.x,s.y,s.z),l.lookAt(s.x,s.y+u[_],s.z)):(l.up.set(0,c[_],0),l.position.set(s.x,s.y,s.z),l.lookAt(s.x,s.y,s.z+u[_]));let S=this._cubeSize;Ra(r,x*S,_>2?S:0,S,S),f.setRenderTarget(r),m&&f.render(v,l),f.render(e,l)}f.toneMapping=d,f.autoClear=h,e.background=y}_textureToCubeUV(e,t){let n=this._renderer,r=e.mapping===zi||e.mapping===Rr;r?(this._cubemapMaterial===null&&(this._cubemapMaterial=Vv()),this._cubemapMaterial.uniforms.flipEnvMap.value=e.isRenderTargetTexture===!1?-1:1):this._equirectMaterial===null&&(this._equirectMaterial=Gv());let s=r?this._cubemapMaterial:this._equirectMaterial,o=this._lodMeshes[0];o.material=s;let a=s.uniforms;a.envMap.value=e;let l=this._cubeSize;Ra(t,0,0,3*l,2*l),n.setRenderTarget(t),n.render(o,cu)}_applyPMREM(e){let t=this._renderer,n=t.autoClear;t.autoClear=!1;let r=this._lodMeshes.length;for(let s=1;s<r;s++)this._applyGGXFilter(e,s-1,s);t.autoClear=n}_applyGGXFilter(e,t,n){let r=this._renderer,s=this._pingPongRenderTarget,o=this._ggxMaterial,a=this._lodMeshes[n];a.material=o;let l=o.uniforms,c=n/(this._lodMeshes.length-1),u=t/(this._lodMeshes.length-1),f=Math.sqrt(c*c-u*u),h=c*1.25,d=f*h,{_lodMax:p}=this,v=this._sizeLods[n],g=3*v*(n>p-Pa?n-p+Pa:0),m=4*(this._cubeSize-v);l.envMap.value=e.texture,l.roughness.value=d,l.mipInt.value=p-t,Ra(s,g,m,3*v,2*v),r.setRenderTarget(s),r.render(a,cu),l.envMap.value=s.texture,l.roughness.value=0,l.mipInt.value=p-n,Ra(e,g,m,3*v,2*v),r.setRenderTarget(e),r.render(a,cu)}_blur(e,t,n,r){let s=this._pingPongRenderTarget,o=Math.min(r,Math.PI)/Math.SQRT2;this._blurPass(e,s,t,n,o),this._blurPass(s,e,n,n,o)}_blurPass(e,t,n,r,s){let o=this._renderer,a=this._blurMaterial,l=this._lodMeshes[r];l.material=a;let c=a.uniforms;c.envMap.value=e.texture,c.sigma.value=s,c.mipInt.value=this._lodMax-n;let u=this._sizeLods[r],f=3*u*(r>this._lodMax-Pa?r-this._lodMax+Pa:0),h=4*(this._cubeSize-u);Ra(t,f,h,3*u,2*u),o.setRenderTarget(t),o.render(l,cu)}};function _b(i){let e=[],t=[],n=i,r=i-Pa+1+gb;for(let s=0;s<r;s++){let o=Math.pow(2,n);e.push(o);let a=1/(o-2),l=-a,c=1+a,u=[l,l,c,l,c,c,l,l,c,c,l,c],f=6,h=6,d=3,p=new Float32Array(d*h*f),v=new Float32Array(d*h*f);for(let m=0;m<f;m++){let y=m%3*2/3-1,_=m>2?0:-1,x=[y,_,0,y+2/3,_,0,y+2/3,_+1,0,y,_,0,y+2/3,_+1,0,y,_+1,0];p.set(x,d*h*m);for(let S=0;S<h;S++){let b=u[S*2]*2-1,E=u[S*2+1]*2-1;m===0?eo.set(1,E,b):m===1?eo.set(-b,1,-E):m===2?eo.set(-b,E,1):m===3?eo.set(-1,E,-b):m===4?eo.set(-b,-1,E):eo.set(b,E,-1),eo.toArray(v,(m*h+S)*d)}}let g=new et;g.setAttribute("position",new ht(p,d)),g.setAttribute("outputDirection",new ht(v,d)),t.push(new at(g,null)),n>Pa&&n--}return{lodMeshes:t,sizeLods:e}}function kv(i,e,t){let n=new Gt(i,e,t);return n.texture.mapping=Zs,n.texture.name="PMREM.cubeUv",n.scissorTest=!0,n}function Ra(i,e,t,n,r){i.viewport.set(e,t,n,r),i.scissor.set(e,t,n,r)}function Mb(i,e,t){return new Lt({name:"PMREMGGXConvolution",defines:{GGX_SAMPLES:xb,CUBEUV_TEXEL_WIDTH:1/e,CUBEUV_TEXEL_HEIGHT:1/t,CUBEUV_MAX_MIP:`${i}.0`},uniforms:{envMap:{value:null},roughness:{value:0},mipInt:{value:0}},vertexShader:Qf(),fragmentShader:`

			precision highp float;
			precision highp int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;
			uniform float roughness;
			uniform float mipInt;

			#define ENVMAP_TYPE_CUBE_UV
			#include <cube_uv_reflection_fragment>

			#define PI 3.14159265359

			// Van der Corput radical inverse
			float radicalInverse_VdC(uint bits) {
				bits = (bits << 16u) | (bits >> 16u);
				bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
				bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
				bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
				bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
				return float(bits) * 2.3283064365386963e-10; // / 0x100000000
			}

			// Hammersley sequence
			vec2 hammersley(uint i, uint N) {
				return vec2(float(i) / float(N), radicalInverse_VdC(i));
			}

			// GGX VNDF importance sampling (Eric Heitz 2018)
			// "Sampling the GGX Distribution of Visible Normals"
			// https://jcgt.org/published/0007/04/01/
			vec3 importanceSampleGGX_VNDF(vec2 Xi, vec3 V, float roughness) {
				float alpha = roughness * roughness;

				// Section 4.1: Orthonormal basis
				vec3 T1 = vec3(1.0, 0.0, 0.0);
				vec3 T2 = cross(V, T1);

				// Section 4.2: Parameterization of projected area
				float r = sqrt(Xi.x);
				float phi = 2.0 * PI * Xi.y;
				float t1 = r * cos(phi);
				float t2 = r * sin(phi);
				float s = 0.5 * (1.0 + V.z);
				t2 = (1.0 - s) * sqrt(1.0 - t1 * t1) + s * t2;

				// Section 4.3: Reprojection onto hemisphere
				vec3 Nh = t1 * T1 + t2 * T2 + sqrt(max(0.0, 1.0 - t1 * t1 - t2 * t2)) * V;

				// Section 3.4: Transform back to ellipsoid configuration
				return normalize(vec3(alpha * Nh.x, alpha * Nh.y, max(0.0, Nh.z)));
			}

			void main() {
				vec3 N = normalize(vOutputDirection);
				vec3 V = N; // Assume view direction equals normal for pre-filtering

				vec3 prefilteredColor = vec3(0.0);
				float totalWeight = 0.0;

				// For very low roughness, just sample the environment directly
				if (roughness < 0.001) {
					gl_FragColor = vec4(bilinearCubeUV(envMap, N, mipInt), 1.0);
					return;
				}

				// Tangent space basis for VNDF sampling
				vec3 up = abs(N.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
				vec3 tangent = normalize(cross(up, N));
				vec3 bitangent = cross(N, tangent);

				for(uint i = 0u; i < uint(GGX_SAMPLES); i++) {
					vec2 Xi = hammersley(i, uint(GGX_SAMPLES));

					// For PMREM, V = N, so in tangent space V is always (0, 0, 1)
					vec3 H_tangent = importanceSampleGGX_VNDF(Xi, vec3(0.0, 0.0, 1.0), roughness);

					// Transform H back to world space
					vec3 H = normalize(tangent * H_tangent.x + bitangent * H_tangent.y + N * H_tangent.z);
					vec3 L = normalize(2.0 * dot(V, H) * H - V);

					float NdotL = max(dot(N, L), 0.0);

					if(NdotL > 0.0) {
						// Sample environment at fixed mip level
						// VNDF importance sampling handles the distribution filtering
						vec3 sampleColor = bilinearCubeUV(envMap, L, mipInt);

						// Weight by NdotL for the split-sum approximation
						// VNDF PDF naturally accounts for the visible microfacet distribution
						prefilteredColor += sampleColor * NdotL;
						totalWeight += NdotL;
					}
				}

				if (totalWeight > 0.0) {
					prefilteredColor = prefilteredColor / totalWeight;
				}

				gl_FragColor = vec4(prefilteredColor, 1.0);
			}
		`,blending:ui,depthTest:!1,depthWrite:!1})}function Sb(i,e,t){return new Lt({name:"SphericalGaussianBlur",defines:{SAMPLES:vb,CUBEUV_TEXEL_WIDTH:1/e,CUBEUV_TEXEL_HEIGHT:1/t,CUBEUV_MAX_MIP:`${i}.0`},uniforms:{envMap:{value:null},sigma:{value:0},mipInt:{value:0}},vertexShader:Qf(),fragmentShader:`

			precision highp float;
			precision highp int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;
			uniform float sigma;
			uniform float mipInt;

			#define ENVMAP_TYPE_CUBE_UV
			#include <cube_uv_reflection_fragment>

			#define PI 3.14159265359
			#define GOLDEN_ANGLE 2.39996322973

			void main() {

				if ( sigma == 0.0 ) {

					gl_FragColor = vec4( bilinearCubeUV( envMap, vOutputDirection, mipInt ), 1.0 );
					return;

				}

				vec3 outputDirection = normalize( vOutputDirection );

				vec3 up = abs( outputDirection.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
				vec3 tangent = normalize( cross( up, outputDirection ) );
				vec3 bitangent = cross( outputDirection, tangent );

				// Truncate the kernel at three standard deviations or at the antipode.
				float thetaMax = min( 3.0 * sigma, PI );
				float truncation = 1.0 - exp( - 0.5 * thetaMax * thetaMax / ( sigma * sigma ) );

				vec3 accumColor = vec3( 0.0 );
				float accumWeight = 0.0;

				for ( int i = 0; i < SAMPLES; i ++ ) {

					// Stratified inverse-CDF sampling of the Gaussian, placed on a golden-angle spiral.
					float stratum = ( float( i ) + 0.5 ) / float( SAMPLES );
					float theta = sigma * sqrt( - 2.0 * log( 1.0 - stratum * truncation ) );
					float phi = float( i ) * GOLDEN_ANGLE;

					vec3 offset = cos( phi ) * tangent + sin( phi ) * bitangent;
					vec3 sampleDirection = cos( theta ) * outputDirection + sin( theta ) * offset;

					// Correct the planar sample density to solid angle.
					float weight = sin( theta ) / theta;

					accumColor += weight * bilinearCubeUV( envMap, sampleDirection, mipInt );
					accumWeight += weight;

				}

				gl_FragColor = vec4( accumColor / accumWeight, 1.0 );

			}
		`,blending:ui,depthTest:!1,depthWrite:!1})}function Gv(){return new Lt({name:"EquirectangularToCubeUV",uniforms:{envMap:{value:null}},vertexShader:Qf(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;

			#include <common>

			void main() {

				vec3 outputDirection = normalize( vOutputDirection );
				vec2 uv = equirectUv( outputDirection );

				gl_FragColor = vec4( texture2D ( envMap, uv ).rgb, 1.0 );

			}
		`,blending:ui,depthTest:!1,depthWrite:!1})}function Vv(){return new Lt({name:"CubemapToCubeUV",uniforms:{envMap:{value:null},flipEnvMap:{value:-1}},vertexShader:Qf(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			uniform float flipEnvMap;

			varying vec3 vOutputDirection;

			uniform samplerCube envMap;

			void main() {

				gl_FragColor = textureCube( envMap, vec3( flipEnvMap * vOutputDirection.x, vOutputDirection.yz ) );

			}
		`,blending:ui,depthTest:!1,depthWrite:!1})}function Qf(){return`

		precision mediump float;
		precision mediump int;

		attribute vec3 outputDirection;

		varying vec3 vOutputDirection;

		void main() {

			vOutputDirection = outputDirection;
			gl_Position = vec4( position, 1.0 );

		}
	`}var fu=class extends Gt{constructor(e=1,t={}){super(e,e,t),this.isWebGLCubeRenderTarget=!0;let n={width:e,height:e,depth:1},r=[n,n,n,n,n,n];this.texture=new Kr(r),this._setTextureOptions(t),this.texture.isRenderTargetTexture=!0}fromEquirectangularTexture(e,t){this.texture.type=t.type,this.texture.colorSpace=t.colorSpace,this.texture.generateMipmaps=t.generateMipmaps,this.texture.minFilter=t.minFilter,this.texture.magFilter=t.magFilter;let n={uniforms:{tEquirect:{value:null}},vertexShader:`

				varying vec3 vWorldDirection;

				vec3 transformDirection( in vec3 dir, in mat4 matrix ) {

					return normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );

				}

				void main() {

					vWorldDirection = transformDirection( position, modelMatrix );

					#include <begin_vertex>
					#include <project_vertex>

				}
			`,fragmentShader:`

				uniform sampler2D tEquirect;

				varying vec3 vWorldDirection;

				#include <common>

				void main() {

					vec3 direction = normalize( vWorldDirection );

					vec2 sampleUV = equirectUv( direction );

					gl_FragColor = texture2D( tEquirect, sampleUV );

				}
			`},r=new In(5,5,5),s=new Lt({name:"CubemapFromEquirect",uniforms:Qs(n.uniforms),vertexShader:n.vertexShader,fragmentShader:n.fragmentShader,side:gn,blending:ui});s.uniforms.tEquirect.value=t;let o=new at(r,s),a=t.minFilter;return t.minFilter===ki&&(t.minFilter=zt),new gc(1,10,this).update(e,o),t.minFilter=a,o.geometry.dispose(),o.material.dispose(),this}clear(e,t=!0,n=!0,r=!0){let s=e.getRenderTarget();for(let o=0;o<6;o++)e.setRenderTarget(this,o),e.clear(t,n,r);e.setRenderTarget(s)}};function bb(i){let e=new WeakMap,t=new WeakMap,n=null;function r(h,d=!1){return h==null?null:d?o(h):s(h)}function s(h){if(h&&h.isTexture){let d=h.mapping;if(d===ya||d===_a)if(e.has(h)){let p=e.get(h).texture;return a(p,h.mapping)}else{let p=h.image;if(p&&p.height>0){let v=new fu(p.height);return v.fromEquirectangularTexture(i,h),e.set(h,v),h.addEventListener("dispose",c),a(v.texture,h.mapping)}else return null}}return h}function o(h){if(h&&h.isTexture){let d=h.mapping,p=d===ya||d===_a,v=d===zi||d===Rr;if(p||v){let g=t.get(h),m=g!==void 0?g.texture.pmremVersion:0;if(h.isRenderTargetTexture&&h.pmremVersion!==m)return n===null&&(n=new to(i)),g=p?n.fromEquirectangular(h,g):n.fromCubemap(h,g),g.texture.pmremVersion=h.pmremVersion,t.set(h,g),g.texture;if(g!==void 0)return g.texture;{let y=h.image;return p&&y&&y.height>0||v&&y&&l(y)?(n===null&&(n=new to(i)),g=p?n.fromEquirectangular(h):n.fromCubemap(h),g.texture.pmremVersion=h.pmremVersion,t.set(h,g),h.addEventListener("dispose",u),g.texture):null}}}return h}function a(h,d){return d===ya?h.mapping=zi:d===_a&&(h.mapping=Rr),h}function l(h){let d=0,p=6;for(let v=0;v<p;v++)h[v]!==void 0&&d++;return d===p}function c(h){let d=h.target;d.removeEventListener("dispose",c);let p=e.get(d);p!==void 0&&(e.delete(d),p.dispose())}function u(h){let d=h.target;d.removeEventListener("dispose",u);let p=t.get(d);p!==void 0&&(t.delete(d),p.dispose())}function f(){e=new WeakMap,t=new WeakMap,n!==null&&(n.dispose(),n=null)}return{get:r,dispose:f}}function wb(i){let e={};function t(n){if(e[n]!==void 0)return e[n];let r=i.getExtension(n);return e[n]=r,r}return{has:function(n){return t(n)!==null},init:function(){t("EXT_color_buffer_float"),t("WEBGL_clip_cull_distance"),t("OES_texture_float_linear"),t("EXT_color_buffer_half_float"),t("WEBGL_multisampled_render_to_texture"),t("WEBGL_render_shared_exponent")},get:function(n){let r=t(n);return r===null&&$i("WebGLRenderer: "+n+" extension not supported."),r}}}function Tb(i,e,t,n){let r={},s=new WeakMap;function o(f){let h=f.target;h.index!==null&&e.remove(h.index);for(let p in h.attributes)e.remove(h.attributes[p]);h.removeEventListener("dispose",o),delete r[h.id];let d=s.get(h);d&&(e.remove(d),s.delete(h)),n.releaseStatesOfGeometry(h),h.isInstancedBufferGeometry===!0&&delete h._maxInstanceCount,t.memory.geometries--}function a(f,h){return r[h.id]===!0||(h.addEventListener("dispose",o),r[h.id]=!0,t.memory.geometries++),h}function l(f){let h=f.attributes;for(let d in h)e.update(h[d],i.ARRAY_BUFFER)}function c(f){let h=[],d=f.index,p=f.attributes.position,v=0;if(p===void 0)return;if(d!==null){let y=d.array;v=d.version;for(let _=0,x=y.length;_<x;_+=3){let S=y[_+0],b=y[_+1],E=y[_+2];h.push(S,b,b,E,E,S)}}else{let y=p.array;v=p.version;for(let _=0,x=y.length/3-1;_<x;_+=3){let S=_+0,b=_+1,E=_+2;h.push(S,b,b,E,E,S)}}let g=new(p.count>=65535?Wo:Ho)(h,1);g.version=v;let m=s.get(f);m&&e.remove(m),s.set(f,g)}function u(f){let h=s.get(f);if(h){let d=f.index;d!==null&&h.version<d.version&&c(f)}else c(f);return s.get(f)}return{get:a,update:l,getWireframeAttribute:u}}function Ab(i,e,t){let n;function r(f){n=f}let s,o;function a(f){s=f.type,o=f.bytesPerElement}function l(f,h){i.drawElements(n,h,s,f*o),t.update(h,n,1)}function c(f,h,d){d!==0&&(i.drawElementsInstanced(n,h,s,f*o,d),t.update(h,n,d))}function u(f,h,d){if(d===0)return;e.get("WEBGL_multi_draw").multiDrawElementsWEBGL(n,h,0,s,f,0,d);let v=0;for(let g=0;g<d;g++)v+=h[g];t.update(v,n,1)}this.setMode=r,this.setIndex=a,this.render=l,this.renderInstances=c,this.renderMultiDraw=u}function Eb(i){let e={geometries:0,textures:0},t={frame:0,calls:0,triangles:0,points:0,lines:0};function n(s,o,a){switch(t.calls++,o){case i.TRIANGLES:t.triangles+=a*(s/3);break;case i.LINES:t.lines+=a*(s/2);break;case i.LINE_STRIP:t.lines+=a*(s-1);break;case i.LINE_LOOP:t.lines+=a*s;break;case i.POINTS:t.points+=a*s;break;default:Qe("WebGLInfo: Unknown draw mode:",o);break}}function r(){t.calls=0,t.triangles=0,t.points=0,t.lines=0}return{memory:e,render:t,programs:null,autoReset:!0,reset:r,update:n}}function Cb(i,e,t){let n=new WeakMap,r=new Pt;function s(o,a,l){let c=o.morphTargetInfluences,u=a.morphAttributes.position||a.morphAttributes.normal||a.morphAttributes.color,f=u!==void 0?u.length:0,h=n.get(a);if(h===void 0||h.count!==f){let T=function(){E.dispose(),n.delete(a),a.removeEventListener("dispose",T)};h!==void 0&&h.texture.dispose();let d=a.morphAttributes.position!==void 0,p=a.morphAttributes.normal!==void 0,v=a.morphAttributes.color!==void 0,g=a.morphAttributes.position||[],m=a.morphAttributes.normal||[],y=a.morphAttributes.color||[],_=0;d===!0&&(_=1),p===!0&&(_=2),v===!0&&(_=3);let x=a.attributes.position.count*_,S=1;x>e.maxTextureSize&&(S=Math.ceil(x/e.maxTextureSize),x=e.maxTextureSize);let b=new Float32Array(x*S*4*f),E=new As(b,x,S,f);E.type=Rn,E.needsUpdate=!0;let M=_*4;for(let A=0;A<f;A++){let I=g[A],D=m[A],B=y[A],F=x*S*4*A;for(let L=0;L<I.count;L++){let U=L*M;d===!0&&(r.fromBufferAttribute(I,L),b[F+U+0]=r.x,b[F+U+1]=r.y,b[F+U+2]=r.z,b[F+U+3]=0),p===!0&&(r.fromBufferAttribute(D,L),b[F+U+4]=r.x,b[F+U+5]=r.y,b[F+U+6]=r.z,b[F+U+7]=0),v===!0&&(r.fromBufferAttribute(B,L),b[F+U+8]=r.x,b[F+U+9]=r.y,b[F+U+10]=r.z,b[F+U+11]=B.itemSize===4?r.w:1)}}h={count:f,texture:E,size:new he(x,S)},n.set(a,h),a.addEventListener("dispose",T)}if(o.isInstancedMesh===!0&&o.morphTexture!==null)l.getUniforms().setValue(i,"morphTexture",o.morphTexture,t);else{let d=0;for(let v=0;v<c.length;v++)d+=c[v];let p=a.morphTargetsRelative?1:1-d;l.getUniforms().setValue(i,"morphTargetBaseInfluence",p),l.getUniforms().setValue(i,"morphTargetInfluences",c)}l.getUniforms().setValue(i,"morphTargetsTexture",h.texture,t),l.getUniforms().setValue(i,"morphTargetsTextureSize",h.size)}return{update:s}}function Rb(i,e,t,n,r){let s=new WeakMap;function o(c){let u=r.render.frame,f=c.geometry,h=e.get(c,f);if(s.get(h)!==u&&(e.update(h),s.set(h,u)),c.isInstancedMesh&&(c.hasEventListener("dispose",l)===!1&&c.addEventListener("dispose",l),s.get(c)!==u&&(t.update(c.instanceMatrix,i.ARRAY_BUFFER),c.instanceColor!==null&&t.update(c.instanceColor,i.ARRAY_BUFFER),s.set(c,u))),c.isSkinnedMesh){let d=c.skeleton;s.get(d)!==u&&(d.update(),s.set(d,u))}return h}function a(){s=new WeakMap}function l(c){let u=c.target;u.removeEventListener("dispose",l),n.releaseStatesOfObject(u),t.remove(u.instanceMatrix),u.instanceColor!==null&&t.remove(u.instanceColor)}return{update:o,dispose:a}}var Pb={[da]:"LINEAR_TONE_MAPPING",[pa]:"REINHARD_TONE_MAPPING",[ma]:"CINEON_TONE_MAPPING",[rs]:"ACES_FILMIC_TONE_MAPPING",[va]:"AGX_TONE_MAPPING",[xa]:"NEUTRAL_TONE_MAPPING",[ga]:"CUSTOM_TONE_MAPPING"};function Ib(i,e,t,n,r,s){let o=new Gt(e,t,{type:i,depthBuffer:r,stencilBuffer:s,samples:n?4:0,storeMultisampledDepthBuffer:!1,storeMultisampledStencilBuffer:!1,resolveDepthBuffer:!1,resolveStencilBuffer:!1}),a=null,l=null,c=new et;c.setAttribute("position",new Ve([-1,3,0,-1,-1,0,3,-1,0],3)),c.setAttribute("uv",new Ve([0,2,0,0,2,0],2));let u=new Qr({uniforms:{tDiffuse:{value:null}},vertexShader:`
			precision highp float;

			uniform mat4 modelViewMatrix;
			uniform mat4 projectionMatrix;

			attribute vec3 position;
			attribute vec2 uv;

			varying vec2 vUv;

			void main() {
				vUv = uv;
				gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
			}`,fragmentShader:`
			precision highp float;

			uniform sampler2D tDiffuse;

			varying vec2 vUv;

			#include <tonemapping_pars_fragment>
			#include <colorspace_pars_fragment>

			void main() {
				gl_FragColor = texture2D( tDiffuse, vUv );

				#ifdef LINEAR_TONE_MAPPING
					gl_FragColor.rgb = LinearToneMapping( gl_FragColor.rgb );
				#elif defined( REINHARD_TONE_MAPPING )
					gl_FragColor.rgb = ReinhardToneMapping( gl_FragColor.rgb );
				#elif defined( CINEON_TONE_MAPPING )
					gl_FragColor.rgb = CineonToneMapping( gl_FragColor.rgb );
				#elif defined( ACES_FILMIC_TONE_MAPPING )
					gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );
				#elif defined( AGX_TONE_MAPPING )
					gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );
				#elif defined( NEUTRAL_TONE_MAPPING )
					gl_FragColor.rgb = NeutralToneMapping( gl_FragColor.rgb );
				#elif defined( CUSTOM_TONE_MAPPING )
					gl_FragColor.rgb = CustomToneMapping( gl_FragColor.rgb );
				#endif

				#ifdef SRGB_TRANSFER
					gl_FragColor = sRGBTransferOETF( gl_FragColor );
				#endif
			}`,depthTest:!1,depthWrite:!1}),f=new at(c,u),h=new tr(-1,1,1,-1,0,1),d=null,p=null,v=!1,g,m=null,y=[],_=!1;this.setSize=function(x,S){o.setSize(x,S),a!==null&&a.setSize(x,S),l!==null&&l.setSize(x,S);for(let b=0;b<y.length;b++){let E=y[b];E.setSize&&E.setSize(x,S)}},this.setEffects=function(x){y=x,_=y.length>0&&y[0].isRenderPass===!0;let S=o.width,b=o.height;y.length>0&&a===null&&(a=new Gt(S,b,{type:ln,depthBuffer:!1,stencilBuffer:!1}),l=new Gt(S,b,{type:ln,depthBuffer:!1,stencilBuffer:!1}));for(let E=0;E<y.length;E++){let M=y[E];M.setSize&&M.setSize(S,b)}},this.begin=function(x,S){if(v||x.toneMapping===Mn&&y.length===0)return!1;if(m=S,S!==null){let b=S.width,E=S.height;(o.width!==b||o.height!==E)&&this.setSize(b,E)}return _===!1&&x.setRenderTarget(o),g=x.toneMapping,x.toneMapping=Mn,!0},this.hasRenderPass=function(){return _},this.end=function(x,S){x.toneMapping=g,v=!0;let b=o,E=a;for(let M=0;M<y.length;M++){let T=y[M];T.enabled!==!1&&(T.render(x,E,b,S),T.needsSwap!==!1&&(b=E,E=E===a?l:a))}if(d!==x.outputColorSpace||p!==x.toneMapping){d=x.outputColorSpace,p=x.toneMapping,u.defines={},vt.getTransfer(d)===bt&&(u.defines.SRGB_TRANSFER="");let M=Pb[p];M&&(u.defines[M]=""),u.needsUpdate=!0}u.uniforms.tDiffuse.value=b.texture,x.setRenderTarget(m),x.render(f,h),m=null,v=!1},this.isCompositing=function(){return v},this.dispose=function(){o.dispose(),a!==null&&a.dispose(),l!==null&&l.dispose(),c.dispose(),u.dispose()}}var lx=new jt,Im=new Sr(1,1),cx=new As,ux=new Es,hx=new Kr,Hv=[],Wv=[],Xv=new Float32Array(16),qv=new Float32Array(9),Yv=new Float32Array(4);function La(i,e,t){let n=i[0];if(n<=0||n>0)return i;let r=e*t,s=Hv[r];if(s===void 0&&(s=new Float32Array(r),Hv[r]=s),e!==0){n.toArray(s,0);for(let o=1,a=0;o!==e;++o)a+=t,i[o].toArray(s,a)}return s}function un(i,e){if(i.length!==e.length)return!1;for(let t=0,n=i.length;t<n;t++)if(i[t]!==e[t])return!1;return!0}function hn(i,e){for(let t=0,n=e.length;t<n;t++)i[t]=e[t]}function ed(i,e){let t=Wv[e];t===void 0&&(t=new Int32Array(e),Wv[e]=t);for(let n=0;n!==e;++n)t[n]=i.allocateTextureUnit();return t}function Lb(i,e){let t=this.cache;t[0]!==e&&(i.uniform1f(this.addr,e),t[0]=e)}function Db(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y)&&(i.uniform2f(this.addr,e.x,e.y),t[0]=e.x,t[1]=e.y);else{if(un(t,e))return;i.uniform2fv(this.addr,e),hn(t,e)}}function Nb(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z)&&(i.uniform3f(this.addr,e.x,e.y,e.z),t[0]=e.x,t[1]=e.y,t[2]=e.z);else if(e.r!==void 0)(t[0]!==e.r||t[1]!==e.g||t[2]!==e.b)&&(i.uniform3f(this.addr,e.r,e.g,e.b),t[0]=e.r,t[1]=e.g,t[2]=e.b);else{if(un(t,e))return;i.uniform3fv(this.addr,e),hn(t,e)}}function Fb(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z||t[3]!==e.w)&&(i.uniform4f(this.addr,e.x,e.y,e.z,e.w),t[0]=e.x,t[1]=e.y,t[2]=e.z,t[3]=e.w);else{if(un(t,e))return;i.uniform4fv(this.addr,e),hn(t,e)}}function Ub(i,e){let t=this.cache,n=e.elements;if(n===void 0){if(un(t,e))return;i.uniformMatrix2fv(this.addr,!1,e),hn(t,e)}else{if(un(t,n))return;Yv.set(n),i.uniformMatrix2fv(this.addr,!1,Yv),hn(t,n)}}function Bb(i,e){let t=this.cache,n=e.elements;if(n===void 0){if(un(t,e))return;i.uniformMatrix3fv(this.addr,!1,e),hn(t,e)}else{if(un(t,n))return;qv.set(n),i.uniformMatrix3fv(this.addr,!1,qv),hn(t,n)}}function Ob(i,e){let t=this.cache,n=e.elements;if(n===void 0){if(un(t,e))return;i.uniformMatrix4fv(this.addr,!1,e),hn(t,e)}else{if(un(t,n))return;Xv.set(n),i.uniformMatrix4fv(this.addr,!1,Xv),hn(t,n)}}function zb(i,e){let t=this.cache;t[0]!==e&&(i.uniform1i(this.addr,e),t[0]=e)}function kb(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y)&&(i.uniform2i(this.addr,e.x,e.y),t[0]=e.x,t[1]=e.y);else{if(un(t,e))return;i.uniform2iv(this.addr,e),hn(t,e)}}function Gb(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z)&&(i.uniform3i(this.addr,e.x,e.y,e.z),t[0]=e.x,t[1]=e.y,t[2]=e.z);else{if(un(t,e))return;i.uniform3iv(this.addr,e),hn(t,e)}}function Vb(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z||t[3]!==e.w)&&(i.uniform4i(this.addr,e.x,e.y,e.z,e.w),t[0]=e.x,t[1]=e.y,t[2]=e.z,t[3]=e.w);else{if(un(t,e))return;i.uniform4iv(this.addr,e),hn(t,e)}}function Hb(i,e){let t=this.cache;t[0]!==e&&(i.uniform1ui(this.addr,e),t[0]=e)}function Wb(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y)&&(i.uniform2ui(this.addr,e.x,e.y),t[0]=e.x,t[1]=e.y);else{if(un(t,e))return;i.uniform2uiv(this.addr,e),hn(t,e)}}function Xb(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z)&&(i.uniform3ui(this.addr,e.x,e.y,e.z),t[0]=e.x,t[1]=e.y,t[2]=e.z);else{if(un(t,e))return;i.uniform3uiv(this.addr,e),hn(t,e)}}function qb(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z||t[3]!==e.w)&&(i.uniform4ui(this.addr,e.x,e.y,e.z,e.w),t[0]=e.x,t[1]=e.y,t[2]=e.z,t[3]=e.w);else{if(un(t,e))return;i.uniform4uiv(this.addr,e),hn(t,e)}}function Yb(i,e,t){let n=this.cache,r=t.allocateTextureUnit();n[0]!==r&&(i.uniform1i(this.addr,r),n[0]=r);let s;this.type===i.SAMPLER_2D_SHADOW?(Im.compareFunction=t.isReversedDepthBuffer()?au:ou,s=Im):s=lx,t.setTexture2D(e||s,r)}function Zb(i,e,t){let n=this.cache,r=t.allocateTextureUnit();n[0]!==r&&(i.uniform1i(this.addr,r),n[0]=r),t.setTexture3D(e||ux,r)}function $b(i,e,t){let n=this.cache,r=t.allocateTextureUnit();n[0]!==r&&(i.uniform1i(this.addr,r),n[0]=r),t.setTextureCube(e||hx,r)}function Jb(i,e,t){let n=this.cache,r=t.allocateTextureUnit();n[0]!==r&&(i.uniform1i(this.addr,r),n[0]=r),t.setTexture2DArray(e||cx,r)}function Kb(i){switch(i){case 5126:return Lb;case 35664:return Db;case 35665:return Nb;case 35666:return Fb;case 35674:return Ub;case 35675:return Bb;case 35676:return Ob;case 5124:case 35670:return zb;case 35667:case 35671:return kb;case 35668:case 35672:return Gb;case 35669:case 35673:return Vb;case 5125:return Hb;case 36294:return Wb;case 36295:return Xb;case 36296:return qb;case 35678:case 36198:case 36298:case 36306:case 35682:return Yb;case 35679:case 36299:case 36307:return Zb;case 35680:case 36300:case 36308:case 36293:return $b;case 36289:case 36303:case 36311:case 36292:return Jb}}function jb(i,e){i.uniform1fv(this.addr,e)}function Qb(i,e){let t=La(e,this.size,2);i.uniform2fv(this.addr,t)}function ew(i,e){let t=La(e,this.size,3);i.uniform3fv(this.addr,t)}function tw(i,e){let t=La(e,this.size,4);i.uniform4fv(this.addr,t)}function nw(i,e){let t=La(e,this.size,4);i.uniformMatrix2fv(this.addr,!1,t)}function iw(i,e){let t=La(e,this.size,9);i.uniformMatrix3fv(this.addr,!1,t)}function rw(i,e){let t=La(e,this.size,16);i.uniformMatrix4fv(this.addr,!1,t)}function sw(i,e){i.uniform1iv(this.addr,e)}function ow(i,e){i.uniform2iv(this.addr,e)}function aw(i,e){i.uniform3iv(this.addr,e)}function lw(i,e){i.uniform4iv(this.addr,e)}function cw(i,e){i.uniform1uiv(this.addr,e)}function uw(i,e){i.uniform2uiv(this.addr,e)}function hw(i,e){i.uniform3uiv(this.addr,e)}function fw(i,e){i.uniform4uiv(this.addr,e)}function dw(i,e,t){let n=this.cache,r=e.length,s=ed(t,r);un(n,s)||(i.uniform1iv(this.addr,s),hn(n,s));let o;this.type===i.SAMPLER_2D_SHADOW?o=Im:o=lx;for(let a=0;a!==r;++a)t.setTexture2D(e[a]||o,s[a])}function pw(i,e,t){let n=this.cache,r=e.length,s=ed(t,r);un(n,s)||(i.uniform1iv(this.addr,s),hn(n,s));for(let o=0;o!==r;++o)t.setTexture3D(e[o]||ux,s[o])}function mw(i,e,t){let n=this.cache,r=e.length,s=ed(t,r);un(n,s)||(i.uniform1iv(this.addr,s),hn(n,s));for(let o=0;o!==r;++o)t.setTextureCube(e[o]||hx,s[o])}function gw(i,e,t){let n=this.cache,r=e.length,s=ed(t,r);un(n,s)||(i.uniform1iv(this.addr,s),hn(n,s));for(let o=0;o!==r;++o)t.setTexture2DArray(e[o]||cx,s[o])}function vw(i){switch(i){case 5126:return jb;case 35664:return Qb;case 35665:return ew;case 35666:return tw;case 35674:return nw;case 35675:return iw;case 35676:return rw;case 5124:case 35670:return sw;case 35667:case 35671:return ow;case 35668:case 35672:return aw;case 35669:case 35673:return lw;case 5125:return cw;case 36294:return uw;case 36295:return hw;case 36296:return fw;case 35678:case 36198:case 36298:case 36306:case 35682:return dw;case 35679:case 36299:case 36307:return pw;case 35680:case 36300:case 36308:case 36293:return mw;case 36289:case 36303:case 36311:case 36292:return gw}}var Lm=class{constructor(e,t,n){this.id=e,this.addr=n,this.cache=[],this.type=t.type,this.setValue=Kb(t.type)}},Dm=class{constructor(e,t,n){this.id=e,this.addr=n,this.cache=[],this.type=t.type,this.size=t.size,this.setValue=vw(t.type)}},Nm=class{constructor(e){this.id=e,this.seq=[],this.map={}}setValue(e,t,n){let r=this.seq;for(let s=0,o=r.length;s!==o;++s){let a=r[s];a.setValue(e,t[a.id],n)}}},Rm=/(\w+)(\])?(\[|\.)?/g;function Zv(i,e){i.seq.push(e),i.map[e.id]=e}function xw(i,e,t){let n=i.name,r=n.length;for(Rm.lastIndex=0;;){let s=Rm.exec(n),o=Rm.lastIndex,a=s[1],l=s[2]==="]",c=s[3];if(l&&(a=a|0),c===void 0||c==="["&&o+2===r){Zv(t,c===void 0?new Lm(a,i,e):new Dm(a,i,e));break}else{let f=t.map[a];f===void 0&&(f=new Nm(a),Zv(t,f)),t=f}}}var Ia=class{constructor(e,t){this.seq=[],this.map={};let n=e.getProgramParameter(t,e.ACTIVE_UNIFORMS);for(let o=0;o<n;++o){let a=e.getActiveUniform(t,o),l=e.getUniformLocation(t,a.name);xw(a,l,this)}let r=[],s=[];for(let o of this.seq)o.type===e.SAMPLER_2D_SHADOW||o.type===e.SAMPLER_CUBE_SHADOW||o.type===e.SAMPLER_2D_ARRAY_SHADOW?r.push(o):s.push(o);r.length>0&&(this.seq=r.concat(s))}setValue(e,t,n,r){let s=this.map[t];s!==void 0&&s.setValue(e,n,r)}setOptional(e,t,n){let r=t[n];r!==void 0&&this.setValue(e,n,r)}static upload(e,t,n,r){for(let s=0,o=t.length;s!==o;++s){let a=t[s],l=n[a.id];l.needsUpdate!==!1&&a.setValue(e,l.value,r)}}static seqWithValue(e,t){let n=[];for(let r=0,s=e.length;r!==s;++r){let o=e[r];o.id in t&&n.push(o)}return n}};function $v(i,e,t){let n=i.createShader(e);return i.shaderSource(n,t),i.compileShader(n),n}var yw=37297,_w=0;function Mw(i,e){let t=i.split(`
`),n=[],r=Math.max(e-6,0),s=Math.min(e+6,t.length);for(let o=r;o<s;o++){let a=o+1;n.push(`${a===e?">":" "} ${a}: ${t[o]}`)}return n.join(`
`)}var Jv=new ft;function Sw(i){vt._getMatrix(Jv,vt.workingColorSpace,i);let e=`mat3( ${Jv.elements.map(t=>t.toFixed(4))} )`;switch(vt.getTransfer(i)){case zo:return[e,"LinearTransferOETF"];case bt:return[e,"sRGBTransferOETF"];default:return Ge("WebGLProgram: Unsupported color space: ",i),[e,"LinearTransferOETF"]}}function Kv(i,e,t){let n=i.getShaderParameter(e,i.COMPILE_STATUS),s=(i.getShaderInfoLog(e)||"").trim();if(n&&s==="")return"";let o=/ERROR: 0:(\d+)/.exec(s);if(o){let a=parseInt(o[1]);return t.toUpperCase()+`

`+s+`

`+Mw(i.getShaderSource(e),a)}else return s}function bw(i,e){let t=Sw(e);return[`vec4 ${i}( vec4 value ) {`,`	return ${t[1]}( vec4( value.rgb * ${t[0]}, value.a ) );`,"}"].join(`
`)}var ww={[da]:"Linear",[pa]:"Reinhard",[ma]:"Cineon",[rs]:"ACESFilmic",[va]:"AgX",[xa]:"Neutral",[ga]:"Custom"};function Tw(i,e){let t=ww[e];return t===void 0?(Ge("WebGLProgram: Unsupported toneMapping:",e),"vec3 "+i+"( vec3 color ) { return LinearToneMapping( color ); }"):"vec3 "+i+"( vec3 color ) { return "+t+"ToneMapping( color ); }"}var jf=new R;function Aw(){vt.getLuminanceCoefficients(jf);let i=jf.x.toFixed(4),e=jf.y.toFixed(4),t=jf.z.toFixed(4);return["float luminance( const in vec3 rgb ) {",`	const vec3 weights = vec3( ${i}, ${e}, ${t} );`,"	return dot( weights, rgb );","}"].join(`
`)}function Ew(i){return[i.extensionClipCullDistance?"#extension GL_ANGLE_clip_cull_distance : require":"",i.extensionMultiDraw?"#extension GL_ANGLE_multi_draw : require":""].filter(hu).join(`
`)}function Cw(i){let e=[];for(let t in i){let n=i[t];n!==!1&&e.push("#define "+t+" "+n)}return e.join(`
`)}function Rw(i,e){let t={},n=i.getProgramParameter(e,i.ACTIVE_ATTRIBUTES);for(let r=0;r<n;r++){let s=i.getActiveAttrib(e,r),o=s.name,a=1;s.type===i.FLOAT_MAT2&&(a=2),s.type===i.FLOAT_MAT3&&(a=3),s.type===i.FLOAT_MAT4&&(a=4),t[o]={type:s.type,location:i.getAttribLocation(e,o),locationSize:a}}return t}function hu(i){return i!==""}function jv(i,e){let t=e.numSpotLightShadows+e.numSpotLightMaps-e.numSpotLightShadowsWithMaps;return i.replace(/NUM_SUN_LIGHTS/g,e.numSunLights).replace(/NUM_DIR_LIGHTS/g,e.numDirLights).replace(/NUM_SPOT_LIGHTS/g,e.numSpotLights).replace(/NUM_SPOT_LIGHT_MAPS/g,e.numSpotLightMaps).replace(/NUM_SPOT_LIGHT_COORDS/g,t).replace(/NUM_RECT_AREA_LIGHTS/g,e.numRectAreaLights).replace(/NUM_POINT_LIGHTS/g,e.numPointLights).replace(/NUM_HEMI_LIGHTS/g,e.numHemiLights).replace(/NUM_SUN_LIGHT_SHADOWS/g,e.numSunLightShadows).replace(/NUM_DIR_LIGHT_SHADOWS/g,e.numDirLightShadows).replace(/NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS/g,e.numSpotLightShadowsWithMaps).replace(/NUM_SPOT_LIGHT_SHADOWS/g,e.numSpotLightShadows).replace(/NUM_POINT_LIGHT_SHADOWS/g,e.numPointLightShadows)}function Qv(i,e){return i.replace(/NUM_CLIPPING_PLANES/g,e.numClippingPlanes).replace(/UNION_CLIPPING_PLANES/g,e.numClippingPlanes-e.numClipIntersection)}var Pw=/^[ \t]*#include +<([\w\d./]+)>/gm;function Fm(i){return i.replace(Pw,Lw)}var Iw=new Map;function Lw(i,e){let t=gt[e];if(t===void 0){let n=Iw.get(e);if(n!==void 0)t=gt[n],Ge('WebGLRenderer: Shader chunk "%s" has been deprecated. Use "%s" instead.',e,n);else throw new Error("THREE.WebGLProgram: Can not resolve #include <"+e+">")}return Fm(t)}var Dw=/#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;function ex(i){return i.replace(Dw,Nw)}function Nw(i,e,t,n){let r="";for(let s=parseInt(e);s<parseInt(t);s++)r+=n.replace(/\[\s*i\s*\]/g,"[ "+s+" ]").replace(/UNROLLED_LOOP_INDEX/g,s);return r}function tx(i){let e=`precision ${i.precision} float;
	precision ${i.precision} int;
	precision ${i.precision} sampler2D;
	precision ${i.precision} samplerCube;
	precision ${i.precision} sampler3D;
	precision ${i.precision} sampler2DArray;
	precision ${i.precision} sampler2DShadow;
	precision ${i.precision} samplerCubeShadow;
	precision ${i.precision} sampler2DArrayShadow;
	precision ${i.precision} isampler2D;
	precision ${i.precision} isampler3D;
	precision ${i.precision} isamplerCube;
	precision ${i.precision} isampler2DArray;
	precision ${i.precision} usampler2D;
	precision ${i.precision} usampler3D;
	precision ${i.precision} usamplerCube;
	precision ${i.precision} usampler2DArray;
	`;return i.precision==="highp"?e+=`
#define HIGH_PRECISION`:i.precision==="mediump"?e+=`
#define MEDIUM_PRECISION`:i.precision==="lowp"&&(e+=`
#define LOW_PRECISION`),e}var Fw={[ns]:"SHADOWMAP_TYPE_PCF",[qs]:"SHADOWMAP_TYPE_VSM"};function Uw(i){return Fw[i.shadowMapType]||"SHADOWMAP_TYPE_BASIC"}var Bw={[zi]:"ENVMAP_TYPE_CUBE",[Rr]:"ENVMAP_TYPE_CUBE",[Zs]:"ENVMAP_TYPE_CUBE_UV"};function Ow(i){return i.envMap===!1?"ENVMAP_TYPE_CUBE":Bw[i.envMapMode]||"ENVMAP_TYPE_CUBE"}var zw={[Rr]:"ENVMAP_MODE_REFRACTION"};function kw(i){return i.envMap===!1?"ENVMAP_MODE_REFLECTION":zw[i.envMapMode]||"ENVMAP_MODE_REFLECTION"}var Gw={[fa]:"ENVMAP_BLENDING_MULTIPLY",[$p]:"ENVMAP_BLENDING_MIX",[Jp]:"ENVMAP_BLENDING_ADD"};function Vw(i){return i.envMap===!1?"ENVMAP_BLENDING_NONE":Gw[i.combine]||"ENVMAP_BLENDING_NONE"}function Hw(i){let e=i.envMapCubeUVHeight;if(e===null)return null;let t=Math.log2(e)-2,n=1/e;return{texelWidth:1/(3*Math.max(Math.pow(2,t),112)),texelHeight:n,maxMip:t}}function Ww(i,e,t,n){let r=i.getContext(),s=t.defines,o=t.vertexShader,a=t.fragmentShader,l=Uw(t),c=Ow(t),u=kw(t),f=Vw(t),h=Hw(t),d=Ew(t),p=Cw(s),v=r.createProgram(),g,m,y=t.glslVersion?"#version "+t.glslVersion+`
`:"";t.isRawShaderMaterial?(g=["#define SHADER_TYPE "+t.shaderType,"#define SHADER_NAME "+t.shaderName,p].filter(hu).join(`
`),g.length>0&&(g+=`
`),m=["#define SHADER_TYPE "+t.shaderType,"#define SHADER_NAME "+t.shaderName,p].filter(hu).join(`
`),m.length>0&&(m+=`
`)):(g=[tx(t),"#define SHADER_TYPE "+t.shaderType,"#define SHADER_NAME "+t.shaderName,p,t.extensionClipCullDistance?"#define USE_CLIP_DISTANCE":"",t.batching?"#define USE_BATCHING":"",t.batchingColor?"#define USE_BATCHING_COLOR":"",t.instancing?"#define USE_INSTANCING":"",t.instancingColor?"#define USE_INSTANCING_COLOR":"",t.instancingMorph?"#define USE_INSTANCING_MORPH":"",t.useFog&&t.fog?"#define USE_FOG":"",t.useFog&&t.fogExp2?"#define FOG_EXP2":"",t.map?"#define USE_MAP":"",t.envMap?"#define USE_ENVMAP":"",t.envMap?"#define "+u:"",t.lightMap?"#define USE_LIGHTMAP":"",t.aoMap?"#define USE_AOMAP":"",t.bumpMap?"#define USE_BUMPMAP":"",t.normalMap?"#define USE_NORMALMAP":"",t.normalMapObjectSpace?"#define USE_NORMALMAP_OBJECTSPACE":"",t.normalMapTangentSpace?"#define USE_NORMALMAP_TANGENTSPACE":"",t.displacementMap?"#define USE_DISPLACEMENTMAP":"",t.emissiveMap?"#define USE_EMISSIVEMAP":"",t.anisotropy?"#define USE_ANISOTROPY":"",t.anisotropyMap?"#define USE_ANISOTROPYMAP":"",t.clearcoatMap?"#define USE_CLEARCOATMAP":"",t.clearcoatRoughnessMap?"#define USE_CLEARCOAT_ROUGHNESSMAP":"",t.clearcoatNormalMap?"#define USE_CLEARCOAT_NORMALMAP":"",t.iridescenceMap?"#define USE_IRIDESCENCEMAP":"",t.iridescenceThicknessMap?"#define USE_IRIDESCENCE_THICKNESSMAP":"",t.specularMap?"#define USE_SPECULARMAP":"",t.specularColorMap?"#define USE_SPECULAR_COLORMAP":"",t.specularIntensityMap?"#define USE_SPECULAR_INTENSITYMAP":"",t.roughnessMap?"#define USE_ROUGHNESSMAP":"",t.metalnessMap?"#define USE_METALNESSMAP":"",t.alphaMap?"#define USE_ALPHAMAP":"",t.alphaHash?"#define USE_ALPHAHASH":"",t.transmission?"#define USE_TRANSMISSION":"",t.transmissionMap?"#define USE_TRANSMISSIONMAP":"",t.thicknessMap?"#define USE_THICKNESSMAP":"",t.sheenColorMap?"#define USE_SHEEN_COLORMAP":"",t.sheenRoughnessMap?"#define USE_SHEEN_ROUGHNESSMAP":"",t.mapUv?"#define MAP_UV "+t.mapUv:"",t.alphaMapUv?"#define ALPHAMAP_UV "+t.alphaMapUv:"",t.lightMapUv?"#define LIGHTMAP_UV "+t.lightMapUv:"",t.aoMapUv?"#define AOMAP_UV "+t.aoMapUv:"",t.emissiveMapUv?"#define EMISSIVEMAP_UV "+t.emissiveMapUv:"",t.bumpMapUv?"#define BUMPMAP_UV "+t.bumpMapUv:"",t.normalMapUv?"#define NORMALMAP_UV "+t.normalMapUv:"",t.displacementMapUv?"#define DISPLACEMENTMAP_UV "+t.displacementMapUv:"",t.metalnessMapUv?"#define METALNESSMAP_UV "+t.metalnessMapUv:"",t.roughnessMapUv?"#define ROUGHNESSMAP_UV "+t.roughnessMapUv:"",t.anisotropyMapUv?"#define ANISOTROPYMAP_UV "+t.anisotropyMapUv:"",t.clearcoatMapUv?"#define CLEARCOATMAP_UV "+t.clearcoatMapUv:"",t.clearcoatNormalMapUv?"#define CLEARCOAT_NORMALMAP_UV "+t.clearcoatNormalMapUv:"",t.clearcoatRoughnessMapUv?"#define CLEARCOAT_ROUGHNESSMAP_UV "+t.clearcoatRoughnessMapUv:"",t.iridescenceMapUv?"#define IRIDESCENCEMAP_UV "+t.iridescenceMapUv:"",t.iridescenceThicknessMapUv?"#define IRIDESCENCE_THICKNESSMAP_UV "+t.iridescenceThicknessMapUv:"",t.sheenColorMapUv?"#define SHEEN_COLORMAP_UV "+t.sheenColorMapUv:"",t.sheenRoughnessMapUv?"#define SHEEN_ROUGHNESSMAP_UV "+t.sheenRoughnessMapUv:"",t.specularMapUv?"#define SPECULARMAP_UV "+t.specularMapUv:"",t.specularColorMapUv?"#define SPECULAR_COLORMAP_UV "+t.specularColorMapUv:"",t.specularIntensityMapUv?"#define SPECULAR_INTENSITYMAP_UV "+t.specularIntensityMapUv:"",t.transmissionMapUv?"#define TRANSMISSIONMAP_UV "+t.transmissionMapUv:"",t.thicknessMapUv?"#define THICKNESSMAP_UV "+t.thicknessMapUv:"",t.vertexTangents&&t.flatShading===!1?"#define USE_TANGENT":"",t.vertexNormals?"#define HAS_NORMAL":"",t.vertexColors?"#define USE_COLOR":"",t.vertexAlphas?"#define USE_COLOR_ALPHA":"",t.vertexUv1s?"#define USE_UV1":"",t.vertexUv2s?"#define USE_UV2":"",t.vertexUv3s?"#define USE_UV3":"",t.pointsUvs?"#define USE_POINTS_UV":"",t.flatShading?"#define FLAT_SHADED":"",t.skinning?"#define USE_SKINNING":"",t.morphTargets?"#define USE_MORPHTARGETS":"",t.morphNormals&&t.flatShading===!1?"#define USE_MORPHNORMALS":"",t.morphColors?"#define USE_MORPHCOLORS":"",t.morphTargetsCount>0?"#define MORPHTARGETS_TEXTURE_STRIDE "+t.morphTextureStride:"",t.morphTargetsCount>0?"#define MORPHTARGETS_COUNT "+t.morphTargetsCount:"",t.doubleSided?"#define DOUBLE_SIDED":"",t.flipSided?"#define FLIP_SIDED":"",t.shadowMapEnabled?"#define USE_SHADOWMAP":"",t.shadowMapEnabled?"#define "+l:"",t.sizeAttenuation?"#define USE_SIZEATTENUATION":"",t.numLightProbes>0?"#define USE_LIGHT_PROBES":"",t.logarithmicDepthBuffer?"#define USE_LOGARITHMIC_DEPTH_BUFFER":"",t.reversedDepthBuffer?"#define USE_REVERSED_DEPTH_BUFFER":"","uniform mat4 modelMatrix;","uniform mat4 modelViewMatrix;","uniform mat4 projectionMatrix;","uniform mat4 viewMatrix;","uniform mat3 normalMatrix;","uniform vec3 cameraPosition;","uniform bool isOrthographic;","#ifdef USE_INSTANCING","	attribute mat4 instanceMatrix;","#endif","#ifdef USE_INSTANCING_COLOR","	attribute vec3 instanceColor;","#endif","#ifdef USE_INSTANCING_MORPH","	uniform sampler2D morphTexture;","#endif","attribute vec3 position;","attribute vec3 normal;","attribute vec2 uv;","#ifdef USE_UV1","	attribute vec2 uv1;","#endif","#ifdef USE_UV2","	attribute vec2 uv2;","#endif","#ifdef USE_UV3","	attribute vec2 uv3;","#endif","#ifdef USE_TANGENT","	attribute vec4 tangent;","#endif","#if defined( USE_COLOR_ALPHA )","	attribute vec4 color;","#elif defined( USE_COLOR )","	attribute vec3 color;","#endif","#ifdef USE_SKINNING","	attribute vec4 skinIndex;","	attribute vec4 skinWeight;","#endif",`
`].filter(hu).join(`
`),m=[tx(t),"#define SHADER_TYPE "+t.shaderType,"#define SHADER_NAME "+t.shaderName,p,t.useFog&&t.fog?"#define USE_FOG":"",t.useFog&&t.fogExp2?"#define FOG_EXP2":"",t.alphaToCoverage?"#define ALPHA_TO_COVERAGE":"",t.map?"#define USE_MAP":"",t.matcap?"#define USE_MATCAP":"",t.envMap?"#define USE_ENVMAP":"",t.envMap?"#define "+c:"",t.envMap?"#define "+u:"",t.envMap?"#define "+f:"",h?"#define CUBEUV_TEXEL_WIDTH "+h.texelWidth:"",h?"#define CUBEUV_TEXEL_HEIGHT "+h.texelHeight:"",h?"#define CUBEUV_MAX_MIP "+h.maxMip+".0":"",t.lightMap?"#define USE_LIGHTMAP":"",t.aoMap?"#define USE_AOMAP":"",t.bumpMap?"#define USE_BUMPMAP":"",t.normalMap?"#define USE_NORMALMAP":"",t.normalMapObjectSpace?"#define USE_NORMALMAP_OBJECTSPACE":"",t.normalMapTangentSpace?"#define USE_NORMALMAP_TANGENTSPACE":"",t.packedNormalMap?"#define USE_PACKED_NORMALMAP":"",t.emissiveMap?"#define USE_EMISSIVEMAP":"",t.anisotropy?"#define USE_ANISOTROPY":"",t.anisotropyMap?"#define USE_ANISOTROPYMAP":"",t.clearcoat?"#define USE_CLEARCOAT":"",t.clearcoatMap?"#define USE_CLEARCOATMAP":"",t.clearcoatRoughnessMap?"#define USE_CLEARCOAT_ROUGHNESSMAP":"",t.clearcoatNormalMap?"#define USE_CLEARCOAT_NORMALMAP":"",t.dispersion?"#define USE_DISPERSION":"",t.retroreflection?"#define USE_RETROREFLECTION":"",t.iridescence?"#define USE_IRIDESCENCE":"",t.iridescenceMap?"#define USE_IRIDESCENCEMAP":"",t.iridescenceThicknessMap?"#define USE_IRIDESCENCE_THICKNESSMAP":"",t.specularMap?"#define USE_SPECULARMAP":"",t.specularColorMap?"#define USE_SPECULAR_COLORMAP":"",t.specularIntensityMap?"#define USE_SPECULAR_INTENSITYMAP":"",t.roughnessMap?"#define USE_ROUGHNESSMAP":"",t.metalnessMap?"#define USE_METALNESSMAP":"",t.alphaMap?"#define USE_ALPHAMAP":"",t.alphaTest?"#define USE_ALPHATEST":"",t.alphaHash?"#define USE_ALPHAHASH":"",t.sheen?"#define USE_SHEEN":"",t.sheenColorMap?"#define USE_SHEEN_COLORMAP":"",t.sheenRoughnessMap?"#define USE_SHEEN_ROUGHNESSMAP":"",t.transmission?"#define USE_TRANSMISSION":"",t.transmissionMap?"#define USE_TRANSMISSIONMAP":"",t.thicknessMap?"#define USE_THICKNESSMAP":"",t.vertexTangents&&t.flatShading===!1?"#define USE_TANGENT":"",t.vertexColors||t.instancingColor?"#define USE_COLOR":"",t.vertexAlphas||t.batchingColor?"#define USE_COLOR_ALPHA":"",t.vertexUv1s?"#define USE_UV1":"",t.vertexUv2s?"#define USE_UV2":"",t.vertexUv3s?"#define USE_UV3":"",t.pointsUvs?"#define USE_POINTS_UV":"",t.gradientMap?"#define USE_GRADIENTMAP":"",t.flatShading?"#define FLAT_SHADED":"",t.doubleSided?"#define DOUBLE_SIDED":"",t.flipSided?"#define FLIP_SIDED":"",t.shadowMapEnabled?"#define USE_SHADOWMAP":"",t.shadowMapEnabled?"#define "+l:"",t.premultipliedAlpha?"#define PREMULTIPLIED_ALPHA":"",t.numLightProbes>0?"#define USE_LIGHT_PROBES":"",t.numLightProbeGrids>0?"#define USE_LIGHT_PROBES_GRID":"",t.decodeVideoTexture?"#define DECODE_VIDEO_TEXTURE":"",t.decodeVideoTextureEmissive?"#define DECODE_VIDEO_TEXTURE_EMISSIVE":"",t.logarithmicDepthBuffer?"#define USE_LOGARITHMIC_DEPTH_BUFFER":"",t.reversedDepthBuffer?"#define USE_REVERSED_DEPTH_BUFFER":"","uniform mat4 viewMatrix;","uniform vec3 cameraPosition;","uniform bool isOrthographic;",t.toneMapping!==Mn?"#define TONE_MAPPING":"",t.toneMapping!==Mn?gt.tonemapping_pars_fragment:"",t.toneMapping!==Mn?Tw("toneMapping",t.toneMapping):"",t.dithering?"#define DITHERING":"",t.opaque?"#define OPAQUE":"",gt.colorspace_pars_fragment,bw("linearToOutputTexel",t.outputColorSpace),Aw(),t.useDepthPacking?"#define DEPTH_PACKING "+t.depthPacking:"",`
`].filter(hu).join(`
`)),o=Fm(o),o=jv(o,t),o=Qv(o,t),a=Fm(a),a=jv(a,t),a=Qv(a,t),o=ex(o),a=ex(a),t.isRawShaderMaterial!==!0&&(y=`#version 300 es
`,g=[d,"#define attribute in","#define varying out","#define texture2D texture"].join(`
`)+`
`+g,m=["#define varying in",t.glslVersion===Zf?"":"layout(location = 0) out highp vec4 pc_fragColor;",t.glslVersion===Zf?"":"#define gl_FragColor pc_fragColor","#define gl_FragDepthEXT gl_FragDepth","#define texture2D texture","#define textureCube texture","#define texture2DProj textureProj","#define texture2DLodEXT textureLod","#define texture2DProjLodEXT textureProjLod","#define textureCubeLodEXT textureLod","#define texture2DGradEXT textureGrad","#define texture2DProjGradEXT textureProjGrad","#define textureCubeGradEXT textureGrad"].join(`
`)+`
`+m);let _=y+g+o,x=y+m+a,S=$v(r,r.VERTEX_SHADER,_),b=$v(r,r.FRAGMENT_SHADER,x);r.attachShader(v,S),r.attachShader(v,b),t.index0AttributeName!==void 0?r.bindAttribLocation(v,0,t.index0AttributeName):t.hasPositionAttribute===!0&&r.bindAttribLocation(v,0,"position"),r.linkProgram(v);function E(I){if(i.debug.checkShaderErrors){let D=r.getProgramInfoLog(v)||"",B=r.getShaderInfoLog(S)||"",F=r.getShaderInfoLog(b)||"",L=D.trim(),U=B.trim(),X=F.trim(),te=!0,Z=!0;if(r.getProgramParameter(v,r.LINK_STATUS)===!1)if(te=!1,typeof i.debug.onShaderError=="function")i.debug.onShaderError(r,v,S,b);else{let K=Kv(r,S,"vertex"),j=Kv(r,b,"fragment");Qe("WebGLProgram: Shader Error "+r.getError()+" - VALIDATE_STATUS "+r.getProgramParameter(v,r.VALIDATE_STATUS)+`

Material Name: `+I.name+`
Material Type: `+I.type+`

Program Info Log: `+L+`
`+K+`
`+j)}else L!==""?Ge("WebGLProgram: Program Info Log:",L):(U===""||X==="")&&(Z=!1);Z&&(I.diagnostics={runnable:te,programLog:L,vertexShader:{log:U,prefix:g},fragmentShader:{log:X,prefix:m}})}r.deleteShader(S),r.deleteShader(b),M=new Ia(r,v),T=Rw(r,v)}let M;this.getUniforms=function(){return M===void 0&&E(this),M};let T;this.getAttributes=function(){return T===void 0&&E(this),T};let A=t.rendererExtensionParallelShaderCompile===!1;return this.isReady=function(){return A===!1&&(A=r.getProgramParameter(v,yw)),A},this.destroy=function(){n.releaseStatesOfProgram(this),r.deleteProgram(v),this.program=void 0},this.type=t.shaderType,this.name=t.shaderName,this.id=_w++,this.cacheKey=e,this.usedTimes=1,this.program=v,this.vertexShader=S,this.fragmentShader=b,this}var Xw=0,Um=class{constructor(){this.shaderCache=new Map,this.materialCache=new Map}update(e,t,n){let r=this._getShaderCacheForMaterial(e);return r.has(t)===!1&&(r.add(t),t.usedTimes++),r.has(n)===!1&&(r.add(n),n.usedTimes++),this}remove(e){let t=this.materialCache.get(e);for(let n of t)n.usedTimes--,n.usedTimes===0&&this.shaderCache.delete(n.code);return this.materialCache.delete(e),this}getVertexShaderStage(e){return this._getShaderStage(e.vertexShader)}getFragmentShaderStage(e){return this._getShaderStage(e.fragmentShader)}dispose(){this.shaderCache.clear(),this.materialCache.clear()}_getShaderCacheForMaterial(e){let t=this.materialCache,n=t.get(e);return n===void 0&&(n=new Set,t.set(e,n)),n}_getShaderStage(e){let t=this.shaderCache,n=t.get(e);return n===void 0&&(n=new Bm(e),t.set(e,n)),n}},Bm=class{constructor(e){this.id=Xw++,this.code=e,this.usedTimes=0}};function qw(i){return i===Ir||i===Ea||i===Ca}function Yw(i,e,t,n,r,s){let o=new Cs,a=new Um,l=new Set,c=[],u=new Map,f=n.logarithmicDepthBuffer,h=n.precision,d={MeshDepthMaterial:"depth",MeshDistanceMaterial:"distance",MeshNormalMaterial:"normal",MeshBasicMaterial:"basic",MeshLambertMaterial:"lambert",MeshPhongMaterial:"phong",MeshToonMaterial:"toon",MeshStandardMaterial:"physical",MeshPhysicalMaterial:"physical",MeshMatcapMaterial:"matcap",LineBasicMaterial:"basic",LineDashedMaterial:"dashed",PointsMaterial:"points",ShadowMaterial:"shadow",SpriteMaterial:"sprite"};function p(M){return l.add(M),M===0?"uv":`uv${M}`}function v(M,T,A,I,D,B){let F=I.fog,L=D.geometry,U=M.isMeshStandardMaterial||M.isMeshLambertMaterial||M.isMeshPhongMaterial?I.environment:null,X=M.isMeshStandardMaterial||M.isMeshLambertMaterial&&!M.envMap||M.isMeshPhongMaterial&&!M.envMap,te=e.get(M.envMap||U,X),Z=te&&te.mapping===Zs?te.image.height:null,K=d[M.type];M.precision!==null&&(h=n.getMaxPrecision(M.precision),h!==M.precision&&Ge("WebGLProgram.getParameters:",M.precision,"not supported, using",h,"instead."));let j=L.morphAttributes.position||L.morphAttributes.normal||L.morphAttributes.color,ne=j!==void 0?j.length:0,ie=0;L.morphAttributes.position!==void 0&&(ie=1),L.morphAttributes.normal!==void 0&&(ie=2),L.morphAttributes.color!==void 0&&(ie=3);let We,Fe,Ye,$;if(K){let Mt=Gi[K];We=Mt.vertexShader,Fe=Mt.fragmentShader}else{We=M.vertexShader,Fe=M.fragmentShader;let Mt=a.getVertexShaderStage(M),ct=a.getFragmentShaderStage(M);a.update(M,Mt,ct),Ye=Mt.id,$=ct.id}let oe=i.getRenderTarget(),Ce=i.state.buffers.depth.getReversed(),He=D.isInstancedMesh===!0,Ee=D.isBatchedMesh===!0,ze=!!M.map,pt=!!M.matcap,ae=!!te,xe=!!M.aoMap,we=!!M.lightMap,Ae=!!M.bumpMap&&M.wireframe===!1,Te=!!M.normalMap,de=!!M.displacementMap,Oe=!!M.emissiveMap,Re=!!M.metalnessMap,Je=!!M.roughnessMap,z=M.anisotropy>0,lt=M.clearcoat>0,rt=M.dispersion>0,P=M.retroreflectivity>0,w=M.iridescence>0,q=M.sheen>0,J=M.transmission>0,G=z&&!!M.anisotropyMap,re=lt&&!!M.clearcoatMap,Q=lt&&!!M.clearcoatNormalMap,V=lt&&!!M.clearcoatRoughnessMap,ee=w&&!!M.iridescenceMap,le=w&&!!M.iridescenceThicknessMap,Se=q&&!!M.sheenColorMap,me=q&&!!M.sheenRoughnessMap,_e=!!M.specularMap,ce=!!M.specularColorMap,fe=!!M.specularIntensityMap,De=J&&!!M.transmissionMap,O=J&&!!M.thicknessMap,Me=!!M.gradientMap,se=!!M.alphaMap,Pe=M.alphaTest>0,Be=!!M.alphaHash,ue=!!M.extensions,je=Mn;M.toneMapped&&(oe===null||oe.isXRRenderTarget===!0)&&(je=i.toneMapping);let Ze={shaderID:K,shaderType:M.type,shaderName:M.name,vertexShader:We,fragmentShader:Fe,defines:M.defines,customVertexShaderID:Ye,customFragmentShaderID:$,isRawShaderMaterial:M.isRawShaderMaterial===!0,glslVersion:M.glslVersion,precision:h,batching:Ee,batchingColor:Ee&&D._colorsTexture!==null,instancing:He,instancingColor:He&&D.instanceColor!==null,instancingMorph:He&&D.morphTexture!==null,outputColorSpace:oe===null?i.outputColorSpace:oe.isXRRenderTarget===!0?oe.texture.colorSpace:vt.workingColorSpace,alphaToCoverage:!!M.alphaToCoverage,map:ze,matcap:pt,envMap:ae,envMapMode:ae&&te.mapping,envMapCubeUVHeight:Z,aoMap:xe,lightMap:we,bumpMap:Ae,normalMap:Te,displacementMap:de,emissiveMap:Oe,normalMapObjectSpace:Te&&M.normalMapType===sm,normalMapTangentSpace:Te&&M.normalMapType===nr,packedNormalMap:Te&&M.normalMapType===nr&&qw(M.normalMap.format),metalnessMap:Re,roughnessMap:Je,anisotropy:z,anisotropyMap:G,clearcoat:lt,clearcoatMap:re,clearcoatNormalMap:Q,clearcoatRoughnessMap:V,dispersion:rt,retroreflection:P,iridescence:w,iridescenceMap:ee,iridescenceThicknessMap:le,sheen:q,sheenColorMap:Se,sheenRoughnessMap:me,specularMap:_e,specularColorMap:ce,specularIntensityMap:fe,transmission:J,transmissionMap:De,thicknessMap:O,gradientMap:Me,opaque:M.transparent===!1&&M.blending===Ys&&M.alphaToCoverage===!1,alphaMap:se,alphaTest:Pe,alphaHash:Be,combine:M.combine,mapUv:ze&&p(M.map.channel),aoMapUv:xe&&p(M.aoMap.channel),lightMapUv:we&&p(M.lightMap.channel),bumpMapUv:Ae&&p(M.bumpMap.channel),normalMapUv:Te&&p(M.normalMap.channel),displacementMapUv:de&&p(M.displacementMap.channel),emissiveMapUv:Oe&&p(M.emissiveMap.channel),metalnessMapUv:Re&&p(M.metalnessMap.channel),roughnessMapUv:Je&&p(M.roughnessMap.channel),anisotropyMapUv:G&&p(M.anisotropyMap.channel),clearcoatMapUv:re&&p(M.clearcoatMap.channel),clearcoatNormalMapUv:Q&&p(M.clearcoatNormalMap.channel),clearcoatRoughnessMapUv:V&&p(M.clearcoatRoughnessMap.channel),iridescenceMapUv:ee&&p(M.iridescenceMap.channel),iridescenceThicknessMapUv:le&&p(M.iridescenceThicknessMap.channel),sheenColorMapUv:Se&&p(M.sheenColorMap.channel),sheenRoughnessMapUv:me&&p(M.sheenRoughnessMap.channel),specularMapUv:_e&&p(M.specularMap.channel),specularColorMapUv:ce&&p(M.specularColorMap.channel),specularIntensityMapUv:fe&&p(M.specularIntensityMap.channel),transmissionMapUv:De&&p(M.transmissionMap.channel),thicknessMapUv:O&&p(M.thicknessMap.channel),alphaMapUv:se&&p(M.alphaMap.channel),vertexTangents:!!L.attributes.tangent&&(Te||z),vertexNormals:!!L.attributes.normal,vertexColors:M.vertexColors,vertexAlphas:M.vertexColors===!0&&!!L.attributes.color&&L.attributes.color.itemSize===4,pointsUvs:D.isPoints===!0&&!!L.attributes.uv&&(ze||se),fog:!!F,useFog:M.fog===!0,fogExp2:!!F&&F.isFogExp2,flatShading:M.wireframe===!1&&(M.flatShading===!0||L.attributes.normal===void 0&&Te===!1&&(M.isMeshLambertMaterial||M.isMeshPhongMaterial||M.isMeshStandardMaterial||M.isMeshPhysicalMaterial)),sizeAttenuation:M.sizeAttenuation===!0,logarithmicDepthBuffer:f,reversedDepthBuffer:Ce,skinning:D.isSkinnedMesh===!0,hasPositionAttribute:L.attributes.position!==void 0,morphTargets:L.morphAttributes.position!==void 0,morphNormals:L.morphAttributes.normal!==void 0,morphColors:L.morphAttributes.color!==void 0,morphTargetsCount:ne,morphTextureStride:ie,numSunLights:T.sun.length,numDirLights:T.directional.length,numPointLights:T.point.length,numSpotLights:T.spot.length,numSpotLightMaps:T.spotLightMap.length,numRectAreaLights:T.rectArea.length,numHemiLights:T.hemi.length,numSunLightShadows:T.sunShadowMap.length,numDirLightShadows:T.directionalShadowMap.length,numPointLightShadows:T.pointShadowMap.length,numSpotLightShadows:T.spotShadowMap.length,numSpotLightShadowsWithMaps:T.numSpotLightShadowsWithMaps,numLightProbes:T.numLightProbes,numLightProbeGrids:B.length,numClippingPlanes:s.numPlanes,numClipIntersection:s.numIntersection,dithering:M.dithering,shadowMapEnabled:i.shadowMap.enabled&&A.length>0,shadowMapType:i.shadowMap.type,toneMapping:je,decodeVideoTexture:ze&&M.map.isVideoTexture===!0&&vt.getTransfer(M.map.colorSpace)===bt,decodeVideoTextureEmissive:Oe&&M.emissiveMap.isVideoTexture===!0&&vt.getTransfer(M.emissiveMap.colorSpace)===bt,premultipliedAlpha:M.premultipliedAlpha,doubleSided:M.side===vn,flipSided:M.side===gn,useDepthPacking:M.depthPacking>=0,depthPacking:M.depthPacking||0,index0AttributeName:M.index0AttributeName,extensionClipCullDistance:ue&&M.extensions.clipCullDistance===!0&&t.has("WEBGL_clip_cull_distance"),extensionMultiDraw:(ue&&M.extensions.multiDraw===!0||Ee)&&t.has("WEBGL_multi_draw"),rendererExtensionParallelShaderCompile:t.has("KHR_parallel_shader_compile"),customProgramCacheKey:M.customProgramCacheKey()};return Ze.vertexUv1s=l.has(1),Ze.vertexUv2s=l.has(2),Ze.vertexUv3s=l.has(3),l.clear(),Ze}function g(M){let T=[];if(M.shaderID?T.push(M.shaderID):(T.push(M.customVertexShaderID),T.push(M.customFragmentShaderID)),M.defines!==void 0)for(let A in M.defines)T.push(A),T.push(M.defines[A]);return M.isRawShaderMaterial===!1&&(m(T,M),y(T,M),T.push(i.outputColorSpace)),T.push(M.customProgramCacheKey),T.join()}function m(M,T){M.push(T.precision),M.push(T.outputColorSpace),M.push(T.envMapMode),M.push(T.envMapCubeUVHeight),M.push(T.mapUv),M.push(T.alphaMapUv),M.push(T.lightMapUv),M.push(T.aoMapUv),M.push(T.bumpMapUv),M.push(T.normalMapUv),M.push(T.displacementMapUv),M.push(T.emissiveMapUv),M.push(T.metalnessMapUv),M.push(T.roughnessMapUv),M.push(T.anisotropyMapUv),M.push(T.clearcoatMapUv),M.push(T.clearcoatNormalMapUv),M.push(T.clearcoatRoughnessMapUv),M.push(T.iridescenceMapUv),M.push(T.iridescenceThicknessMapUv),M.push(T.sheenColorMapUv),M.push(T.sheenRoughnessMapUv),M.push(T.specularMapUv),M.push(T.specularColorMapUv),M.push(T.specularIntensityMapUv),M.push(T.transmissionMapUv),M.push(T.thicknessMapUv),M.push(T.combine),M.push(T.fogExp2),M.push(T.sizeAttenuation),M.push(T.morphTargetsCount),M.push(T.morphAttributeCount),M.push(T.numSunLights),M.push(T.numDirLights),M.push(T.numPointLights),M.push(T.numSpotLights),M.push(T.numSpotLightMaps),M.push(T.numHemiLights),M.push(T.numRectAreaLights),M.push(T.numSunLightShadows),M.push(T.numDirLightShadows),M.push(T.numPointLightShadows),M.push(T.numSpotLightShadows),M.push(T.numSpotLightShadowsWithMaps),M.push(T.numLightProbes),M.push(T.shadowMapType),M.push(T.toneMapping),M.push(T.numClippingPlanes),M.push(T.numClipIntersection),M.push(T.depthPacking)}function y(M,T){o.disableAll(),T.instancing&&o.enable(0),T.instancingColor&&o.enable(1),T.instancingMorph&&o.enable(2),T.matcap&&o.enable(3),T.envMap&&o.enable(4),T.normalMapObjectSpace&&o.enable(5),T.normalMapTangentSpace&&o.enable(6),T.clearcoat&&o.enable(7),T.iridescence&&o.enable(8),T.alphaTest&&o.enable(9),T.vertexColors&&o.enable(10),T.vertexAlphas&&o.enable(11),T.vertexUv1s&&o.enable(12),T.vertexUv2s&&o.enable(13),T.vertexUv3s&&o.enable(14),T.vertexTangents&&o.enable(15),T.anisotropy&&o.enable(16),T.alphaHash&&o.enable(17),T.batching&&o.enable(18),T.dispersion&&o.enable(19),T.retroreflection&&o.enable(24),T.batchingColor&&o.enable(20),T.gradientMap&&o.enable(21),T.packedNormalMap&&o.enable(22),T.vertexNormals&&o.enable(23),M.push(o.mask),o.disableAll(),T.fog&&o.enable(0),T.useFog&&o.enable(1),T.flatShading&&o.enable(2),T.logarithmicDepthBuffer&&o.enable(3),T.reversedDepthBuffer&&o.enable(4),T.skinning&&o.enable(5),T.morphTargets&&o.enable(6),T.morphNormals&&o.enable(7),T.morphColors&&o.enable(8),T.premultipliedAlpha&&o.enable(9),T.shadowMapEnabled&&o.enable(10),T.doubleSided&&o.enable(11),T.flipSided&&o.enable(12),T.useDepthPacking&&o.enable(13),T.dithering&&o.enable(14),T.transmission&&o.enable(15),T.sheen&&o.enable(16),T.opaque&&o.enable(17),T.pointsUvs&&o.enable(18),T.decodeVideoTexture&&o.enable(19),T.decodeVideoTextureEmissive&&o.enable(20),T.alphaToCoverage&&o.enable(21),T.numLightProbeGrids>0&&o.enable(22),T.hasPositionAttribute&&o.enable(23),M.push(o.mask)}function _(M){let T=d[M.type],A;if(T){let I=Gi[T];A=rr.clone(I.uniforms)}else A=M.uniforms;return A}function x(M,T){let A=u.get(T);return A!==void 0?++A.usedTimes:(A=new Ww(i,T,M,r),c.push(A),u.set(T,A)),A}function S(M){if(--M.usedTimes===0){let T=c.indexOf(M);c[T]=c[c.length-1],c.pop(),u.delete(M.cacheKey),M.destroy()}}function b(M){a.remove(M)}function E(){a.dispose()}return{getParameters:v,getProgramCacheKey:g,getUniforms:_,acquireProgram:x,releaseProgram:S,releaseShaderCache:b,programs:c,dispose:E}}function Zw(){let i=new WeakMap;function e(o){return i.has(o)}function t(o){let a=i.get(o);return a===void 0&&(a={},i.set(o,a)),a}function n(o){i.delete(o)}function r(o,a,l){i.get(o)[a]=l}function s(){i=new WeakMap}return{has:e,get:t,remove:n,update:r,dispose:s}}function $w(i,e){return i.groupOrder!==e.groupOrder?i.groupOrder-e.groupOrder:i.renderOrder!==e.renderOrder?i.renderOrder-e.renderOrder:i.material.id!==e.material.id?i.material.id-e.material.id:i.materialVariant!==e.materialVariant?i.materialVariant-e.materialVariant:i.z!==e.z?i.z-e.z:i.id-e.id}function nx(i,e){return i.groupOrder!==e.groupOrder?i.groupOrder-e.groupOrder:i.renderOrder!==e.renderOrder?i.renderOrder-e.renderOrder:i.z!==e.z?e.z-i.z:i.id-e.id}function ix(){let i=[],e=0,t=[],n=[],r=[];function s(){e=0,t.length=0,n.length=0,r.length=0}function o(h){let d=0;return h.isInstancedMesh&&(d+=2),h.isSkinnedMesh&&(d+=1),d}function a(h,d,p,v,g,m){let y=i[e];return y===void 0?(y={id:h.id,object:h,geometry:d,material:p,materialVariant:o(h),groupOrder:v,renderOrder:h.renderOrder,z:g,group:m},i[e]=y):(y.id=h.id,y.object=h,y.geometry=d,y.material=p,y.materialVariant=o(h),y.groupOrder=v,y.renderOrder=h.renderOrder,y.z=g,y.group=m),e++,y}function l(h,d,p,v,g,m,y){y.reversedDepth===!0&&(g=-g);let _=a(h,d,p,v,g,m);p.transmission>0?n.push(_):p.transparent===!0?r.push(_):t.push(_)}function c(h,d,p,v,g,m){let y=a(h,d,p,v,g,m);p.transmission>0?n.unshift(y):p.transparent===!0?r.unshift(y):t.unshift(y)}function u(h,d){t.length>1&&t.sort(h||$w),n.length>1&&n.sort(d||nx),r.length>1&&r.sort(d||nx)}function f(){for(let h=e,d=i.length;h<d;h++){let p=i[h];if(p.id===null)break;p.id=null,p.object=null,p.geometry=null,p.material=null,p.group=null}}return{opaque:t,transmissive:n,transparent:r,init:s,push:l,unshift:c,finish:f,sort:u}}function Jw(){let i=new WeakMap;function e(n,r){let s=i.get(n),o;return s===void 0?(o=new ix,i.set(n,[o])):r>=s.length?(o=new ix,s.push(o)):o=s[r],o}function t(){i=new WeakMap}return{get:e,dispose:t}}function Kw(){let i={};return{get:function(e){if(i[e.id]!==void 0)return i[e.id];let t;switch(e.type){case"SunLight":case"DirectionalLight":t={direction:new R,color:new be};break;case"SpotLight":t={position:new R,direction:new R,color:new be,distance:0,coneCos:0,penumbraCos:0,decay:0};break;case"PointLight":t={position:new R,color:new be,distance:0,decay:0};break;case"HemisphereLight":t={direction:new R,skyColor:new be,groundColor:new be};break;case"RectAreaLight":t={color:new be,position:new R,halfWidth:new R,halfHeight:new R};break}return i[e.id]=t,t}}}function jw(){let i={};return{get:function(e){if(i[e.id]!==void 0)return i[e.id];let t;switch(e.type){case"SunLight":case"DirectionalLight":t={shadowIntensity:1,shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new he};break;case"SpotLight":t={shadowIntensity:1,shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new he};break;case"PointLight":t={shadowIntensity:1,shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new he,shadowCameraNear:1,shadowCameraFar:1e3};break}return i[e.id]=t,t}}}var Qw=0;function e2(i,e){return(e.castShadow?2:0)-(i.castShadow?2:0)+(e.map?1:0)-(i.map?1:0)}function t2(i){let e=new Kw,t=jw(),n={version:0,hash:{sunLength:-1,directionalLength:-1,pointLength:-1,spotLength:-1,rectAreaLength:-1,hemiLength:-1,numSunShadows:-1,numDirectionalShadows:-1,numPointShadows:-1,numSpotShadows:-1,numSpotMaps:-1,numLightProbes:-1},ambient:[0,0,0],probe:[],sun:[],sunShadow:[],sunShadowMap:[],sunShadowMatrix:[],sunShadowCascade:[],directional:[],directionalShadow:[],directionalShadowMap:[],directionalShadowMatrix:[],spot:[],spotLightMap:[],spotShadow:[],spotShadowMap:[],spotLightMatrix:[],rectArea:[],rectAreaLTC1:null,rectAreaLTC2:null,point:[],pointShadow:[],pointShadowMap:[],pointShadowMatrix:[],hemi:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};for(let c=0;c<9;c++)n.probe.push(new R);let r=new R,s=new it,o=new it;function a(c){let u=0,f=0,h=0;for(let D=0;D<9;D++)n.probe[D].set(0,0,0);let d=0,p=0,v=0,g=0,m=0,y=0,_=0,x=0,S=0,b=0,E=0,M=0,T=0,A=0;c.sort(e2);for(let D=0,B=c.length;D<B;D++){let F=c[D],L=F.color,U=F.intensity,X=F.distance,te=null;if(F.shadow&&F.shadow.map&&(F.shadow.map.texture.format===Ir?te=F.shadow.map.texture:te=F.shadow.map.depthTexture||F.shadow.map.texture),F.isAmbientLight)u+=L.r*U,f+=L.g*U,h+=L.b*U;else if(F.isLightProbe){for(let Z=0;Z<9;Z++)n.probe[Z].addScaledVector(F.sh.coefficients[Z],U);A++}else if(F.isSunLight){let Z=e.get(F);if(Z.color.copy(F.color).multiplyScalar(F.intensity),F.castShadow){let K=F.shadow,j=t.get(F);j.shadowIntensity=K.intensity,j.shadowBias=K.bias,j.shadowNormalBias=K.normalBias,j.shadowRadius=K.radius,j.shadowMapSize.copy(K.mapSize).multiply(K.getFrameExtents()),n.sunShadow[p]=j,n.sunShadowMap[p]=te;let ne=K.getViewportCount();for(let ie=0;ie<ne;ie++)n.sunShadowMatrix[v+ie]=K.getMatrix(ie),n.sunShadowCascade[v+ie]=K._cascadeData[ie];v+=ne,p++}n.sun[d]=Z,d++}else if(F.isDirectionalLight){let Z=e.get(F);if(Z.color.copy(F.color).multiplyScalar(F.intensity),F.castShadow){let K=F.shadow,j=t.get(F);j.shadowIntensity=K.intensity,j.shadowBias=K.bias,j.shadowNormalBias=K.normalBias,j.shadowRadius=K.radius,j.shadowMapSize=K.mapSize,n.directionalShadow[g]=j,n.directionalShadowMap[g]=te,n.directionalShadowMatrix[g]=F.shadow.matrix,S++}n.directional[g]=Z,g++}else if(F.isSpotLight){let Z=e.get(F);Z.position.setFromMatrixPosition(F.matrixWorld),Z.color.copy(L).multiplyScalar(U),Z.distance=X,Z.coneCos=Math.cos(F.angle),Z.penumbraCos=Math.cos(F.angle*(1-F.penumbra)),Z.decay=F.decay,n.spot[y]=Z;let K=F.shadow;if(F.map&&(n.spotLightMap[M]=F.map,M++,K.updateMatrices(F),F.castShadow&&T++),n.spotLightMatrix[y]=K.matrix,F.castShadow){let j=t.get(F);j.shadowIntensity=K.intensity,j.shadowBias=K.bias,j.shadowNormalBias=K.normalBias,j.shadowRadius=K.radius,j.shadowMapSize=K.mapSize,n.spotShadow[y]=j,n.spotShadowMap[y]=te,E++}y++}else if(F.isRectAreaLight){let Z=e.get(F);Z.color.copy(L).multiplyScalar(U),Z.halfWidth.set(F.width*.5,0,0),Z.halfHeight.set(0,F.height*.5,0),n.rectArea[_]=Z,_++}else if(F.isPointLight){let Z=e.get(F);if(Z.color.copy(F.color).multiplyScalar(F.intensity),Z.distance=F.distance,Z.decay=F.decay,F.castShadow){let K=F.shadow,j=t.get(F);j.shadowIntensity=K.intensity,j.shadowBias=K.bias,j.shadowNormalBias=K.normalBias,j.shadowRadius=K.radius,j.shadowMapSize=K.mapSize,j.shadowCameraNear=K.camera.near,j.shadowCameraFar=K.camera.far,n.pointShadow[m]=j,n.pointShadowMap[m]=te,n.pointShadowMatrix[m]=F.shadow.matrix,b++}n.point[m]=Z,m++}else if(F.isHemisphereLight){let Z=e.get(F);Z.skyColor.copy(F.color).multiplyScalar(U),Z.groundColor.copy(F.groundColor).multiplyScalar(U),n.hemi[x]=Z,x++}}_>0&&(i.has("OES_texture_float_linear")===!0?(n.rectAreaLTC1=Xe.LTC_FLOAT_1,n.rectAreaLTC2=Xe.LTC_FLOAT_2):(n.rectAreaLTC1=Xe.LTC_HALF_1,n.rectAreaLTC2=Xe.LTC_HALF_2)),n.ambient[0]=u,n.ambient[1]=f,n.ambient[2]=h;let I=n.hash;(I.sunLength!==d||I.directionalLength!==g||I.pointLength!==m||I.spotLength!==y||I.rectAreaLength!==_||I.hemiLength!==x||I.numSunShadows!==p||I.numDirectionalShadows!==S||I.numPointShadows!==b||I.numSpotShadows!==E||I.numSpotMaps!==M||I.numLightProbes!==A)&&(n.sun.length=d,n.directional.length=g,n.spot.length=y,n.rectArea.length=_,n.point.length=m,n.hemi.length=x,n.sunShadow.length=p,n.sunShadowMap.length=p,n.sunShadowMatrix.length=v,n.sunShadowCascade.length=v,n.directionalShadow.length=S,n.directionalShadowMap.length=S,n.directionalShadowMatrix.length=S,n.pointShadow.length=b,n.pointShadowMap.length=b,n.pointShadowMatrix.length=b,n.spotShadow.length=E,n.spotShadowMap.length=E,n.spotLightMatrix.length=E+M-T,n.spotLightMap.length=M,n.numSpotLightShadowsWithMaps=T,n.numLightProbes=A,I.sunLength=d,I.directionalLength=g,I.pointLength=m,I.spotLength=y,I.rectAreaLength=_,I.hemiLength=x,I.numSunShadows=p,I.numDirectionalShadows=S,I.numPointShadows=b,I.numSpotShadows=E,I.numSpotMaps=M,I.numLightProbes=A,n.version=Qw++)}function l(c,u){let f=0,h=0,d=0,p=0,v=0,g=0,m=u.matrixWorldInverse;for(let y=0,_=c.length;y<_;y++){let x=c[y];if(x.isSunLight){let S=n.sun[f];S.direction.setFromMatrixPosition(x.matrixWorld),S.direction.transformDirection(m),f++}else if(x.isDirectionalLight){let S=n.directional[h];S.direction.setFromMatrixPosition(x.matrixWorld),r.setFromMatrixPosition(x.target.matrixWorld),S.direction.sub(r),S.direction.transformDirection(m),h++}else if(x.isSpotLight){let S=n.spot[p];S.position.setFromMatrixPosition(x.matrixWorld),S.position.applyMatrix4(m),S.direction.setFromMatrixPosition(x.matrixWorld),r.setFromMatrixPosition(x.target.matrixWorld),S.direction.sub(r),S.direction.transformDirection(m),p++}else if(x.isRectAreaLight){let S=n.rectArea[v];S.position.setFromMatrixPosition(x.matrixWorld),S.position.applyMatrix4(m),o.identity(),s.copy(x.matrixWorld),s.premultiply(m),o.extractRotation(s),S.halfWidth.set(x.width*.5,0,0),S.halfHeight.set(0,x.height*.5,0),S.halfWidth.applyMatrix4(o),S.halfHeight.applyMatrix4(o),v++}else if(x.isPointLight){let S=n.point[d];S.position.setFromMatrixPosition(x.matrixWorld),S.position.applyMatrix4(m),d++}else if(x.isHemisphereLight){let S=n.hemi[g];S.direction.setFromMatrixPosition(x.matrixWorld),S.direction.transformDirection(m),g++}}}return{setup:a,setupView:l,state:n}}function rx(i){let e=new t2(i),t=[],n=[],r=[];function s(h){f.camera=h,t.length=0,n.length=0,r.length=0}function o(h){t.push(h)}function a(h){n.push(h)}function l(h){r.push(h)}function c(){e.setup(t)}function u(h){e.setupView(t,h)}let f={lightsArray:t,shadowsArray:n,lightProbeGridArray:r,camera:null,lights:e,transmissionRenderTarget:{},textureUnits:0};return{init:s,state:f,setupLights:c,setupLightsView:u,pushLight:o,pushShadow:a,pushLightProbeGrid:l}}function n2(i){let e=new WeakMap;function t(r,s=0){let o=e.get(r),a;return o===void 0?(a=new rx(i),e.set(r,[a])):s>=o.length?(a=new rx(i),o.push(a)):a=o[s],a}function n(){e=new WeakMap}return{get:t,dispose:n}}var i2=`void main() {
	gl_Position = vec4( position, 1.0 );
}`,r2=`uniform sampler2D shadow_pass;
uniform vec2 resolution;
uniform float radius;
void main() {
	const float samples = float( VSM_SAMPLES );
	float mean = 0.0;
	float squared_mean = 0.0;
	float uvStride = samples <= 1.0 ? 0.0 : 2.0 / ( samples - 1.0 );
	float uvStart = samples <= 1.0 ? 0.0 : - 1.0;
	for ( float i = 0.0; i < samples; i ++ ) {
		float uvOffset = uvStart + i * uvStride;
		#ifdef HORIZONTAL_PASS
			vec2 distribution = texture2D( shadow_pass, ( gl_FragCoord.xy + vec2( uvOffset, 0.0 ) * radius ) / resolution ).rg;
			mean += distribution.x;
			squared_mean += distribution.y * distribution.y + distribution.x * distribution.x;
		#else
			float depth = texture2D( shadow_pass, ( gl_FragCoord.xy + vec2( 0.0, uvOffset ) * radius ) / resolution ).r;
			mean += depth;
			squared_mean += depth * depth;
		#endif
	}
	mean = mean / samples;
	squared_mean = squared_mean / samples;
	float std_dev = sqrt( max( 0.0, squared_mean - mean * mean ) );
	gl_FragColor = vec4( mean, std_dev, 0.0, 1.0 );
}`,s2=[new R(1,0,0),new R(-1,0,0),new R(0,1,0),new R(0,-1,0),new R(0,0,1),new R(0,0,-1)],o2=[new R(0,-1,0),new R(0,-1,0),new R(0,0,1),new R(0,0,-1),new R(0,-1,0),new R(0,-1,0)],sx=new it,uu=new R,Pm=new R;function a2(i,e,t){let n=new Ki,r=new he,s=new he,o=new Pt,a=new ia,l=new ra,c={},u=t.maxTextureSize,f={[Er]:gn,[gn]:Er,[vn]:vn},h=new Lt({defines:{VSM_SAMPLES:8},uniforms:{shadow_pass:{value:null},resolution:{value:new he},radius:{value:4}},vertexShader:i2,fragmentShader:r2}),d=h.clone();d.defines.HORIZONTAL_PASS=1;let p=new et;p.setAttribute("position",new ht(new Float32Array([-1,-1,.5,3,-1,.5,-1,3,.5]),3));let v=new at(p,h),g=this;this.enabled=!1,this.autoUpdate=!0,this.needsUpdate=!1,this.type=ns;let m=this.type;this.render=function(b,E,M){if(g.enabled===!1||g.autoUpdate===!1&&g.needsUpdate===!1||b.length===0)return;this.type===Pp&&(Ge("WebGLShadowMap: PCFSoftShadowMap has been removed. Using PCFShadowMap instead."),this.type=ns);let T=i.getRenderTarget(),A=i.getActiveCubeFace(),I=i.getActiveMipmapLevel(),D=i.state;D.setBlending(ui),D.buffers.depth.getReversed()===!0?D.buffers.color.setClear(0,0,0,0):D.buffers.color.setClear(1,1,1,1),D.buffers.depth.setTest(!0),D.setScissorTest(!1);let B=m!==this.type;B&&E.traverse(function(F){F.material&&(Array.isArray(F.material)?F.material.forEach(L=>L.needsUpdate=!0):F.material.needsUpdate=!0)});for(let F=0,L=b.length;F<L;F++){let U=b[F],X=U.shadow;if(X===void 0){Ge("WebGLShadowMap:",U,"has no shadow.");continue}if(X.autoUpdate===!1&&X.needsUpdate===!1)continue;r.copy(X.mapSize);let te=X.getFrameExtents();r.multiply(te),s.copy(X.mapSize),(r.x>u||r.y>u)&&(r.x>u&&(s.x=Math.floor(u/te.x),r.x=s.x*te.x,X.mapSize.x=s.x),r.y>u&&(s.y=Math.floor(u/te.y),r.y=s.y*te.y,X.mapSize.y=s.y));let Z=i.state.buffers.depth.getReversed();if(X.camera._reversedDepth=Z,X.map===null||B===!0){if(X.map!==null&&(X.map.depthTexture!==null&&(X.map.depthTexture.dispose(),X.map.depthTexture=null),X.map.dispose()),this.type===qs){if(U.isPointLight){Ge("WebGLShadowMap: VSM shadow maps are not supported for PointLights. Use PCF or BasicShadowMap instead.");continue}X.map=new Gt(r.x,r.y,{format:Ir,type:ln,minFilter:zt,magFilter:zt,generateMipmaps:!1}),X.map.texture.name=U.name+".shadowMap",X.map.depthTexture=new Sr(r.x,r.y,Rn),X.map.depthTexture.name=U.name+".shadowMapDepth",X.map.depthTexture.format=Ui,X.map.depthTexture.compareFunction=null,X.map.depthTexture.minFilter=Kt,X.map.depthTexture.magFilter=Kt}else U.isPointLight?(X.map=new fu(r.x),X.map.depthTexture=new Dl(r.x,hi)):(X.map=new Gt(r.x,r.y),X.map.depthTexture=new Sr(r.x,r.y,hi)),X.map.depthTexture.name=U.name+".shadowMap",X.map.depthTexture.format=Ui,this.type===ns?(X.map.depthTexture.compareFunction=Z?au:ou,X.map.depthTexture.minFilter=zt,X.map.depthTexture.magFilter=zt):(X.map.depthTexture.compareFunction=null,X.map.depthTexture.minFilter=Kt,X.map.depthTexture.magFilter=Kt);X.camera.updateProjectionMatrix()}X.map.isWebGLCubeRenderTarget!==!0&&(X.map.width!==r.x||X.map.height!==r.y)&&X.map.setSize(r.x,r.y);let K=X.map.isWebGLCubeRenderTarget?6:X.getViewportCount();U.isPointLight!==!0&&X.updateMatrices(U,M);for(let j=0;j<K;j++){let ne=X.getCamera(j);if(U.isPointLight){let ie=X.camera,We=X.matrix,Fe=U.distance||ie.far;Fe!==ie.far&&(ie.far=Fe,ie.updateProjectionMatrix()),uu.setFromMatrixPosition(U.matrixWorld),ie.position.copy(uu),Pm.copy(ie.position),Pm.add(s2[j]),ie.up.copy(o2[j]),ie.lookAt(Pm),ie.updateMatrixWorld(),We.makeTranslation(-uu.x,-uu.y,-uu.z),sx.multiplyMatrices(ie.projectionMatrix,ie.matrixWorldInverse),X._frustum.setFromProjectionMatrix(sx,ie.coordinateSystem,ie.reversedDepth)}if(X.map.isWebGLCubeRenderTarget)i.setRenderTarget(X.map,j),i.clear();else{j===0&&(i.setRenderTarget(X.map),i.clear());let ie=X.getViewport(j);o.set(s.x*ie.x,s.y*ie.y,s.x*ie.z,s.y*ie.w),D.viewport(o)}n=X.getFrustum(j),x(E,M,ne,U,this.type)}X.isPointLightShadow!==!0&&this.type===qs&&y(X,M),X.needsUpdate=!1}m=this.type,g.needsUpdate=!1,i.setRenderTarget(T,A,I)};function y(b,E){let M=e.update(v);h.defines.VSM_SAMPLES!==b.blurSamples&&(h.defines.VSM_SAMPLES=b.blurSamples,d.defines.VSM_SAMPLES=b.blurSamples,h.needsUpdate=!0,d.needsUpdate=!0),b.mapPass===null?b.mapPass=new Gt(r.x,r.y,{format:Ir,type:ln}):(b.mapPass.width!==b.map.width||b.mapPass.height!==b.map.height)&&b.mapPass.setSize(b.map.width,b.map.height),h.uniforms.shadow_pass.value=b.map.depthTexture,h.uniforms.resolution.value.set(b.map.width,b.map.height),h.uniforms.radius.value=b.radius,i.setRenderTarget(b.mapPass),i.clear(),i.renderBufferDirect(E,null,M,h,v,null),d.uniforms.shadow_pass.value=b.mapPass.texture,d.uniforms.resolution.value.set(b.map.width,b.map.height),d.uniforms.radius.value=b.radius,i.setRenderTarget(b.map),i.clear(),i.renderBufferDirect(E,null,M,d,v,null)}function _(b,E,M,T){let A=null,I=M.isPointLight===!0?b.customDistanceMaterial:b.customDepthMaterial;if(I!==void 0)A=I;else if(A=M.isPointLight===!0?l:a,i.localClippingEnabled&&E.clipShadows===!0&&Array.isArray(E.clippingPlanes)&&E.clippingPlanes.length!==0||E.displacementMap&&E.displacementScale!==0||E.alphaMap&&E.alphaTest>0||E.map&&E.alphaTest>0||E.alphaToCoverage===!0){let D=A.uuid,B=E.uuid,F=c[D];F===void 0&&(F={},c[D]=F);let L=F[B];L===void 0&&(L=A.clone(),F[B]=L,E.addEventListener("dispose",S)),A=L}if(A.visible=E.visible,A.wireframe=E.wireframe,T===qs?A.side=E.shadowSide!==null?E.shadowSide:E.side:A.side=E.shadowSide!==null?E.shadowSide:f[E.side],A.alphaMap=E.alphaMap,A.alphaTest=E.alphaToCoverage===!0?.5:E.alphaTest,A.map=E.map,A.clipShadows=E.clipShadows,A.clippingPlanes=E.clippingPlanes,A.clipIntersection=E.clipIntersection,A.displacementMap=E.displacementMap,A.displacementScale=E.displacementScale,A.displacementBias=E.displacementBias,A.wireframeLinewidth=E.wireframeLinewidth,A.linewidth=E.linewidth,M.isPointLight===!0&&A.isMeshDistanceMaterial===!0){let D=i.properties.get(A);D.light=M}return A}function x(b,E,M,T,A){if(b.visible===!1)return;if(b.layers.test(E.layers)&&(b.isMesh||b.isLine||b.isPoints)&&(b.castShadow||b.receiveShadow&&A===qs)&&(!b.frustumCulled||b.intersectsFrustum(n))){b.modelViewMatrix.multiplyMatrices(M.matrixWorldInverse,b.matrixWorld);let B=e.update(b),F=b.material;if(Array.isArray(F)){let L=B.groups;for(let U=0,X=L.length;U<X;U++){let te=L[U],Z=F[te.materialIndex];if(Z&&Z.visible){let K=_(b,Z,T,A);b.onBeforeShadow(i,b,E,M,B,K,te),i.renderBufferDirect(M,null,B,K,b,te),b.onAfterShadow(i,b,E,M,B,K,te)}}}else if(F.visible){let L=_(b,F,T,A);b.onBeforeShadow(i,b,E,M,B,L,null),i.renderBufferDirect(M,null,B,L,b,null),b.onAfterShadow(i,b,E,M,B,L,null)}}let D=b.children;for(let B=0,F=D.length;B<F;B++)x(D[B],E,M,T,A)}function S(b){b.target.removeEventListener("dispose",S);for(let M in c){let T=c[M],A=b.target.uuid;A in T&&(T[A].dispose(),delete T[A])}}}function l2(i,e){function t(){let O=!1,Me=new Pt,se=null,Pe=new Pt(0,0,0,0);return{setMask:function(Be){se!==Be&&!O&&(i.colorMask(Be,Be,Be,Be),se=Be)},setLocked:function(Be){O=Be},setClear:function(Be,ue,je,Ze,Mt){Mt===!0&&(Be*=Ze,ue*=Ze,je*=Ze),Me.set(Be,ue,je,Ze),Pe.equals(Me)===!1&&(i.clearColor(Be,ue,je,Ze),Pe.copy(Me))},reset:function(){O=!1,se=null,Pe.set(-1,0,0,0)}}}function n(){let O=!1,Me=!1,se=null,Pe=null,Be=null;return{setReversed:function(ue){if(Me!==ue){let je=e.get("EXT_clip_control");ue?je.clipControlEXT(je.LOWER_LEFT_EXT,je.ZERO_TO_ONE_EXT):je.clipControlEXT(je.LOWER_LEFT_EXT,je.NEGATIVE_ONE_TO_ONE_EXT),Me=ue;let Ze=Be;Be=null,this.setClear(Ze)}},getReversed:function(){return Me},setTest:function(ue){ue?oe(i.DEPTH_TEST):Ce(i.DEPTH_TEST)},setMask:function(ue){se!==ue&&!O&&(i.depthMask(ue),se=ue)},setFunc:function(ue){if(Me&&(ue=Cv[ue]),Pe!==ue){switch(ue){case ml:i.depthFunc(i.NEVER);break;case gl:i.depthFunc(i.ALWAYS);break;case vl:i.depthFunc(i.LESS);break;case ws:i.depthFunc(i.LEQUAL);break;case xl:i.depthFunc(i.EQUAL);break;case yl:i.depthFunc(i.GEQUAL);break;case _l:i.depthFunc(i.GREATER);break;case Ml:i.depthFunc(i.NOTEQUAL);break;default:i.depthFunc(i.LEQUAL)}Pe=ue}},setLocked:function(ue){O=ue},setClear:function(ue){Be!==ue&&(Be=ue,Me&&(ue=1-ue),i.clearDepth(ue))},reset:function(){O=!1,se=null,Pe=null,Be=null,Me=!1}}}function r(){let O=!1,Me=null,se=null,Pe=null,Be=null,ue=null,je=null,Ze=null,Mt=null;return{setTest:function(ct){O||(ct?oe(i.STENCIL_TEST):Ce(i.STENCIL_TEST))},setMask:function(ct){Me!==ct&&!O&&(i.stencilMask(ct),Me=ct)},setFunc:function(ct,Vt,kt){(se!==ct||Pe!==Vt||Be!==kt)&&(i.stencilFunc(ct,Vt,kt),se=ct,Pe=Vt,Be=kt)},setOp:function(ct,Vt,kt){(ue!==ct||je!==Vt||Ze!==kt)&&(i.stencilOp(ct,Vt,kt),ue=ct,je=Vt,Ze=kt)},setLocked:function(ct){O=ct},setClear:function(ct){Mt!==ct&&(i.clearStencil(ct),Mt=ct)},reset:function(){O=!1,Me=null,se=null,Pe=null,Be=null,ue=null,je=null,Ze=null,Mt=null}}}let s=new t,o=new n,a=new r,l=new WeakMap,c=new WeakMap,u={},f={},h={},d=new WeakMap,p=[],v=null,g=!1,m=null,y=null,_=null,x=null,S=null,b=null,E=null,M=new be(0,0,0),T=0,A=!1,I=null,D=null,B=null,F=null,L=null,U=i.getParameter(i.MAX_COMBINED_TEXTURE_IMAGE_UNITS),X=!1,te=0,Z=i.getParameter(i.VERSION);Z.indexOf("WebGL")!==-1?(te=parseFloat(/^WebGL (\d)/.exec(Z)[1]),X=te>=1):Z.indexOf("OpenGL ES")!==-1&&(te=parseFloat(/^OpenGL ES (\d)/.exec(Z)[1]),X=te>=2);let K=null,j={},ne=i.getParameter(i.SCISSOR_BOX),ie=i.getParameter(i.VIEWPORT),We=new Pt().fromArray(ne),Fe=new Pt().fromArray(ie);function Ye(O,Me,se,Pe){let Be=new Uint8Array(4),ue=i.createTexture();i.bindTexture(O,ue),i.texParameteri(O,i.TEXTURE_MIN_FILTER,i.NEAREST),i.texParameteri(O,i.TEXTURE_MAG_FILTER,i.NEAREST);for(let je=0;je<se;je++)O===i.TEXTURE_3D||O===i.TEXTURE_2D_ARRAY?i.texImage3D(Me,0,i.RGBA,1,1,Pe,0,i.RGBA,i.UNSIGNED_BYTE,Be):i.texImage2D(Me+je,0,i.RGBA,1,1,0,i.RGBA,i.UNSIGNED_BYTE,Be);return ue}let $={};$[i.TEXTURE_2D]=Ye(i.TEXTURE_2D,i.TEXTURE_2D,1),$[i.TEXTURE_CUBE_MAP]=Ye(i.TEXTURE_CUBE_MAP,i.TEXTURE_CUBE_MAP_POSITIVE_X,6),$[i.TEXTURE_2D_ARRAY]=Ye(i.TEXTURE_2D_ARRAY,i.TEXTURE_2D_ARRAY,1,1),$[i.TEXTURE_3D]=Ye(i.TEXTURE_3D,i.TEXTURE_3D,1,1),s.setClear(0,0,0,1),o.setClear(1),a.setClear(0),oe(i.DEPTH_TEST),o.setFunc(ws),Ae(!1),Te(Ff),oe(i.CULL_FACE),xe(ui);function oe(O){u[O]!==!0&&(i.enable(O),u[O]=!0)}function Ce(O){u[O]!==!1&&(i.disable(O),u[O]=!1)}function He(O,Me){return h[O]!==Me?(i.bindFramebuffer(O,Me),h[O]=Me,O===i.DRAW_FRAMEBUFFER&&(h[i.FRAMEBUFFER]=Me),O===i.FRAMEBUFFER&&(h[i.DRAW_FRAMEBUFFER]=Me),!0):!1}function Ee(O,Me){let se=p,Pe=!1;if(O){se=d.get(Me),se===void 0&&(se=[],d.set(Me,se));let Be=O.textures;if(se.length!==Be.length||se[0]!==i.COLOR_ATTACHMENT0){for(let ue=0,je=Be.length;ue<je;ue++)se[ue]=i.COLOR_ATTACHMENT0+ue;se.length=Be.length,Pe=!0}}else se[0]!==i.BACK&&(se[0]=i.BACK,Pe=!0);Pe&&i.drawBuffers(se)}function ze(O){return v!==O?(i.useProgram(O),v=O,!0):!1}let pt={[is]:i.FUNC_ADD,[Lp]:i.FUNC_SUBTRACT,[Dp]:i.FUNC_REVERSE_SUBTRACT};pt[Np]=i.MIN,pt[Fp]=i.MAX;let ae={[Up]:i.ZERO,[Bp]:i.ONE,[Op]:i.SRC_COLOR,[Of]:i.SRC_ALPHA,[Wp]:i.SRC_ALPHA_SATURATE,[Vp]:i.DST_COLOR,[kp]:i.DST_ALPHA,[zp]:i.ONE_MINUS_SRC_COLOR,[zf]:i.ONE_MINUS_SRC_ALPHA,[Hp]:i.ONE_MINUS_DST_COLOR,[Gp]:i.ONE_MINUS_DST_ALPHA,[Xp]:i.CONSTANT_COLOR,[qp]:i.ONE_MINUS_CONSTANT_COLOR,[Yp]:i.CONSTANT_ALPHA,[Zp]:i.ONE_MINUS_CONSTANT_ALPHA};function xe(O,Me,se,Pe,Be,ue,je,Ze,Mt,ct){if(O===ui){g===!0&&(Ce(i.BLEND),g=!1);return}if(g===!1&&(oe(i.BLEND),g=!0),O!==Ip){if(O!==m||ct!==A){if((y!==is||S!==is)&&(i.blendEquation(i.FUNC_ADD),y=is,S=is),ct)switch(O){case Ys:i.blendFuncSeparate(i.ONE,i.ONE_MINUS_SRC_ALPHA,i.ONE,i.ONE_MINUS_SRC_ALPHA);break;case Cr:i.blendFunc(i.ONE,i.ONE);break;case Uf:i.blendFuncSeparate(i.ZERO,i.ONE_MINUS_SRC_COLOR,i.ZERO,i.ONE);break;case Bf:i.blendFuncSeparate(i.DST_COLOR,i.ONE_MINUS_SRC_ALPHA,i.ZERO,i.ONE);break;default:Qe("WebGLState: Invalid blending: ",O);break}else switch(O){case Ys:i.blendFuncSeparate(i.SRC_ALPHA,i.ONE_MINUS_SRC_ALPHA,i.ONE,i.ONE_MINUS_SRC_ALPHA);break;case Cr:i.blendFuncSeparate(i.SRC_ALPHA,i.ONE,i.ONE,i.ONE);break;case Uf:Qe("WebGLState: SubtractiveBlending requires material.premultipliedAlpha = true");break;case Bf:Qe("WebGLState: MultiplyBlending requires material.premultipliedAlpha = true");break;default:Qe("WebGLState: Invalid blending: ",O);break}_=null,x=null,b=null,E=null,M.set(0,0,0),T=0,m=O,A=ct}return}Be=Be||Me,ue=ue||se,je=je||Pe,(Me!==y||Be!==S)&&(i.blendEquationSeparate(pt[Me],pt[Be]),y=Me,S=Be),(se!==_||Pe!==x||ue!==b||je!==E)&&(i.blendFuncSeparate(ae[se],ae[Pe],ae[ue],ae[je]),_=se,x=Pe,b=ue,E=je),(Ze.equals(M)===!1||Mt!==T)&&(i.blendColor(Ze.r,Ze.g,Ze.b,Mt),M.copy(Ze),T=Mt),m=O,A=!1}function we(O,Me){O.side===vn?Ce(i.CULL_FACE):oe(i.CULL_FACE);let se=O.side===gn;Me&&(se=!se),Ae(se),O.blending===Ys&&O.transparent===!1?xe(ui):xe(O.blending,O.blendEquation,O.blendSrc,O.blendDst,O.blendEquationAlpha,O.blendSrcAlpha,O.blendDstAlpha,O.blendColor,O.blendAlpha,O.premultipliedAlpha),o.setFunc(O.depthFunc),o.setTest(O.depthTest),o.setMask(O.depthWrite),s.setMask(O.colorWrite);let Pe=O.stencilWrite;a.setTest(Pe),Pe&&(a.setMask(O.stencilWriteMask),a.setFunc(O.stencilFunc,O.stencilRef,O.stencilFuncMask),a.setOp(O.stencilFail,O.stencilZFail,O.stencilZPass)),Oe(O.polygonOffset,O.polygonOffsetFactor,O.polygonOffsetUnits),O.alphaToCoverage===!0?oe(i.SAMPLE_ALPHA_TO_COVERAGE):Ce(i.SAMPLE_ALPHA_TO_COVERAGE)}function Ae(O){I!==O&&(O?i.frontFace(i.CW):i.frontFace(i.CCW),I=O)}function Te(O){O!==Cp?(oe(i.CULL_FACE),O!==D&&(O===Ff?i.cullFace(i.BACK):O===Rp?i.cullFace(i.FRONT):i.cullFace(i.FRONT_AND_BACK))):Ce(i.CULL_FACE),D=O}function de(O){O!==B&&(X&&i.lineWidth(O),B=O)}function Oe(O,Me,se){O?(oe(i.POLYGON_OFFSET_FILL),(F!==Me||L!==se)&&(F=Me,L=se,o.getReversed()&&(Me=-Me),i.polygonOffset(Me,se))):Ce(i.POLYGON_OFFSET_FILL)}function Re(O){O?oe(i.SCISSOR_TEST):Ce(i.SCISSOR_TEST)}function Je(O){O===void 0&&(O=i.TEXTURE0+U-1),K!==O&&(i.activeTexture(O),K=O)}function z(O,Me,se){se===void 0&&(K===null?se=i.TEXTURE0+U-1:se=K);let Pe=j[se];Pe===void 0&&(Pe={type:void 0,texture:void 0},j[se]=Pe),(Pe.type!==O||Pe.texture!==Me)&&(K!==se&&(i.activeTexture(se),K=se),i.bindTexture(O,Me||$[O]),Pe.type=O,Pe.texture=Me)}function lt(){let O=j[K];O!==void 0&&O.type!==void 0&&(i.bindTexture(O.type,null),O.type=void 0,O.texture=void 0)}function rt(){try{i.compressedTexImage2D(...arguments)}catch(O){Qe("WebGLState:",O)}}function P(){try{i.compressedTexImage3D(...arguments)}catch(O){Qe("WebGLState:",O)}}function w(){try{i.texSubImage2D(...arguments)}catch(O){Qe("WebGLState:",O)}}function q(){try{i.texSubImage3D(...arguments)}catch(O){Qe("WebGLState:",O)}}function J(){try{i.compressedTexSubImage2D(...arguments)}catch(O){Qe("WebGLState:",O)}}function G(){try{i.compressedTexSubImage3D(...arguments)}catch(O){Qe("WebGLState:",O)}}function re(){try{i.texStorage2D(...arguments)}catch(O){Qe("WebGLState:",O)}}function Q(){try{i.texStorage3D(...arguments)}catch(O){Qe("WebGLState:",O)}}function V(){try{i.texImage2D(...arguments)}catch(O){Qe("WebGLState:",O)}}function ee(){try{i.texImage3D(...arguments)}catch(O){Qe("WebGLState:",O)}}function le(O){return f[O]!==void 0?f[O]:i.getParameter(O)}function Se(O,Me){f[O]!==Me&&(i.pixelStorei(O,Me),f[O]=Me)}function me(O){We.equals(O)===!1&&(i.scissor(O.x,O.y,O.z,O.w),We.copy(O))}function _e(O){Fe.equals(O)===!1&&(i.viewport(O.x,O.y,O.z,O.w),Fe.copy(O))}function ce(O,Me){let se=c.get(Me);se===void 0&&(se=new WeakMap,c.set(Me,se));let Pe=se.get(O);Pe===void 0&&(Pe=i.getUniformBlockIndex(Me,O.name),se.set(O,Pe))}function fe(O,Me){let Pe=c.get(Me).get(O);l.get(Me)!==Pe&&(i.uniformBlockBinding(Me,Pe,O.__bindingPointIndex),l.set(Me,Pe))}function De(){i.disable(i.BLEND),i.disable(i.CULL_FACE),i.disable(i.DEPTH_TEST),i.disable(i.POLYGON_OFFSET_FILL),i.disable(i.SCISSOR_TEST),i.disable(i.STENCIL_TEST),i.disable(i.SAMPLE_ALPHA_TO_COVERAGE),i.blendEquation(i.FUNC_ADD),i.blendFunc(i.ONE,i.ZERO),i.blendFuncSeparate(i.ONE,i.ZERO,i.ONE,i.ZERO),i.blendColor(0,0,0,0),i.colorMask(!0,!0,!0,!0),i.clearColor(0,0,0,0),i.depthMask(!0),i.depthFunc(i.LESS),o.setReversed(!1),i.clearDepth(1),i.stencilMask(4294967295),i.stencilFunc(i.ALWAYS,0,4294967295),i.stencilOp(i.KEEP,i.KEEP,i.KEEP),i.clearStencil(0),i.cullFace(i.BACK),i.frontFace(i.CCW),i.polygonOffset(0,0),i.activeTexture(i.TEXTURE0),i.bindFramebuffer(i.FRAMEBUFFER,null),i.bindFramebuffer(i.DRAW_FRAMEBUFFER,null),i.bindFramebuffer(i.READ_FRAMEBUFFER,null),i.useProgram(null),i.lineWidth(1),i.scissor(0,0,i.canvas.width,i.canvas.height),i.viewport(0,0,i.canvas.width,i.canvas.height),i.pixelStorei(i.PACK_ALIGNMENT,4),i.pixelStorei(i.UNPACK_ALIGNMENT,4),i.pixelStorei(i.UNPACK_FLIP_Y_WEBGL,!1),i.pixelStorei(i.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!1),i.pixelStorei(i.UNPACK_COLORSPACE_CONVERSION_WEBGL,i.BROWSER_DEFAULT_WEBGL),i.pixelStorei(i.PACK_ROW_LENGTH,0),i.pixelStorei(i.PACK_SKIP_PIXELS,0),i.pixelStorei(i.PACK_SKIP_ROWS,0),i.pixelStorei(i.UNPACK_ROW_LENGTH,0),i.pixelStorei(i.UNPACK_IMAGE_HEIGHT,0),i.pixelStorei(i.UNPACK_SKIP_PIXELS,0),i.pixelStorei(i.UNPACK_SKIP_ROWS,0),i.pixelStorei(i.UNPACK_SKIP_IMAGES,0),u={},f={},K=null,j={},h={},d=new WeakMap,p=[],v=null,g=!1,m=null,y=null,_=null,x=null,S=null,b=null,E=null,M=new be(0,0,0),T=0,A=!1,I=null,D=null,B=null,F=null,L=null,We.set(0,0,i.canvas.width,i.canvas.height),Fe.set(0,0,i.canvas.width,i.canvas.height),s.reset(),o.reset(),a.reset()}return{buffers:{color:s,depth:o,stencil:a},enable:oe,disable:Ce,bindFramebuffer:He,drawBuffers:Ee,useProgram:ze,setBlending:xe,setMaterial:we,setFlipSided:Ae,setCullFace:Te,setLineWidth:de,setPolygonOffset:Oe,setScissorTest:Re,activeTexture:Je,bindTexture:z,unbindTexture:lt,compressedTexImage2D:rt,compressedTexImage3D:P,texImage2D:V,texImage3D:ee,pixelStorei:Se,getParameter:le,updateUBOMapping:ce,uniformBlockBinding:fe,texStorage2D:re,texStorage3D:Q,texSubImage2D:w,texSubImage3D:q,compressedTexSubImage2D:J,compressedTexSubImage3D:G,scissor:me,viewport:_e,reset:De}}function c2(i,e,t,n,r,s,o){let a=e.has("WEBGL_multisampled_render_to_texture")?e.get("WEBGL_multisampled_render_to_texture"):null,l=typeof navigator>"u"?!1:/OculusBrowser/g.test(navigator.userAgent),c=new he,u=new WeakMap,f=new Set,h,d=new WeakMap,p=!1;try{p=typeof OffscreenCanvas<"u"&&new OffscreenCanvas(1,1).getContext("2d")!==null}catch{}function v(P,w){return p?new OffscreenCanvas(P,w):ko("canvas")}function g(P,w,q){let J=1,G=rt(P);if((G.width>q||G.height>q)&&(J=q/Math.max(G.width,G.height)),J<1)if(typeof HTMLImageElement<"u"&&P instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&P instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&P instanceof ImageBitmap||typeof VideoFrame<"u"&&P instanceof VideoFrame){let re=Math.floor(J*G.width),Q=Math.floor(J*G.height);h===void 0&&(h=v(re,Q));let V=w?v(re,Q):h;return V.width=re,V.height=Q,V.getContext("2d").drawImage(P,0,0,re,Q),Ge("WebGLRenderer: Texture has been resized from ("+G.width+"x"+G.height+") to ("+re+"x"+Q+")."),V}else return"data"in P&&Ge("WebGLRenderer: Image in DataTexture is too big ("+G.width+"x"+G.height+")."),P;return P}function m(P){return P.generateMipmaps}function y(P){i.generateMipmap(P)}function _(P){return P.isWebGLCubeRenderTarget?i.TEXTURE_CUBE_MAP:P.isWebGL3DRenderTarget?i.TEXTURE_3D:P.isWebGLArrayRenderTarget||P.isCompressedArrayTexture?i.TEXTURE_2D_ARRAY:i.TEXTURE_2D}function x(P,w,q,J,G,re=!1){if(P!==null){if(i[P]!==void 0)return i[P];Ge("WebGLRenderer: Attempt to use non-existing WebGL internal format '"+P+"'")}let Q;J&&(Q=e.get("EXT_texture_norm16"),Q||Ge("WebGLRenderer: Unable to use normalized textures without EXT_texture_norm16 extension"));let V=w;if(w===i.RED&&(q===i.FLOAT&&(V=i.R32F),q===i.HALF_FLOAT&&(V=i.R16F),q===i.UNSIGNED_BYTE&&(V=i.R8),q===i.UNSIGNED_SHORT&&Q&&(V=Q.R16_EXT),q===i.SHORT&&Q&&(V=Q.R16_SNORM_EXT)),w===i.RED_INTEGER&&(q===i.UNSIGNED_BYTE&&(V=i.R8UI),q===i.UNSIGNED_SHORT&&(V=i.R16UI),q===i.UNSIGNED_INT&&(V=i.R32UI),q===i.BYTE&&(V=i.R8I),q===i.SHORT&&(V=i.R16I),q===i.INT&&(V=i.R32I)),w===i.RG&&(q===i.FLOAT&&(V=i.RG32F),q===i.HALF_FLOAT&&(V=i.RG16F),q===i.UNSIGNED_BYTE&&(V=i.RG8),q===i.UNSIGNED_SHORT&&Q&&(V=Q.RG16_EXT),q===i.SHORT&&Q&&(V=Q.RG16_SNORM_EXT)),w===i.RG_INTEGER&&(q===i.UNSIGNED_BYTE&&(V=i.RG8UI),q===i.UNSIGNED_SHORT&&(V=i.RG16UI),q===i.UNSIGNED_INT&&(V=i.RG32UI),q===i.BYTE&&(V=i.RG8I),q===i.SHORT&&(V=i.RG16I),q===i.INT&&(V=i.RG32I)),w===i.RGB_INTEGER&&(q===i.UNSIGNED_BYTE&&(V=i.RGB8UI),q===i.UNSIGNED_SHORT&&(V=i.RGB16UI),q===i.UNSIGNED_INT&&(V=i.RGB32UI),q===i.BYTE&&(V=i.RGB8I),q===i.SHORT&&(V=i.RGB16I),q===i.INT&&(V=i.RGB32I)),w===i.RGBA_INTEGER&&(q===i.UNSIGNED_BYTE&&(V=i.RGBA8UI),q===i.UNSIGNED_SHORT&&(V=i.RGBA16UI),q===i.UNSIGNED_INT&&(V=i.RGBA32UI),q===i.BYTE&&(V=i.RGBA8I),q===i.SHORT&&(V=i.RGBA16I),q===i.INT&&(V=i.RGBA32I)),w===i.RGB&&(q===i.UNSIGNED_SHORT&&Q&&(V=Q.RGB16_EXT),q===i.SHORT&&Q&&(V=Q.RGB16_SNORM_EXT),q===i.UNSIGNED_INT_5_9_9_9_REV&&(V=i.RGB9_E5),q===i.UNSIGNED_INT_10F_11F_11F_REV&&(V=i.R11F_G11F_B10F)),w===i.RGBA){let ee=re?zo:vt.getTransfer(G);q===i.FLOAT&&(V=i.RGBA32F),q===i.HALF_FLOAT&&(V=i.RGBA16F),q===i.UNSIGNED_BYTE&&(V=ee===bt?i.SRGB8_ALPHA8:i.RGBA8),q===i.UNSIGNED_SHORT&&Q&&(V=Q.RGBA16_EXT),q===i.SHORT&&Q&&(V=Q.RGBA16_SNORM_EXT),q===i.UNSIGNED_SHORT_4_4_4_4&&(V=i.RGBA4),q===i.UNSIGNED_SHORT_5_5_5_1&&(V=i.RGB5_A1)}return(V===i.R16F||V===i.R32F||V===i.RG16F||V===i.RG32F||V===i.RGBA16F||V===i.RGBA32F)&&e.get("EXT_color_buffer_float"),V}function S(P,w){let q;return P?w===null||w===hi||w===Ks?q=i.DEPTH24_STENCIL8:w===Rn?q=i.DEPTH32F_STENCIL8:w===Js&&(q=i.DEPTH24_STENCIL8,Ge("DepthTexture: 16 bit depth attachment is not supported with stencil. Using 24-bit attachment.")):w===null||w===hi||w===Ks?q=i.DEPTH_COMPONENT24:w===Rn?q=i.DEPTH_COMPONENT32F:w===Js&&(q=i.DEPTH_COMPONENT16),q}function b(P,w){return m(P)===!0||P.isFramebufferTexture&&P.minFilter!==Kt&&P.minFilter!==zt?Math.log2(Math.max(w.width,w.height))+1:P.mipmaps!==void 0&&P.mipmaps.length>0?P.mipmaps.length:P.isCompressedTexture&&Array.isArray(P.image)?w.mipmaps.length:1}function E(P){let w=P.target;w.removeEventListener("dispose",E),T(w),w.isVideoTexture&&u.delete(w),w.isHTMLTexture&&f.delete(w)}function M(P){let w=P.target;w.removeEventListener("dispose",M),I(w)}function T(P){let w=n.get(P);if(w.__webglInit===void 0)return;let q=P.source,J=d.get(q);if(J){let G=J[w.__cacheKey];G.usedTimes--,G.usedTimes===0&&A(P),Object.keys(J).length===0&&d.delete(q)}n.remove(P)}function A(P){let w=n.get(P);i.deleteTexture(w.__webglTexture);let q=P.source,J=d.get(q);delete J[w.__cacheKey],o.memory.textures--}function I(P){let w=n.get(P);if(P.depthTexture&&(P.depthTexture.dispose(),n.remove(P.depthTexture)),P.isWebGLCubeRenderTarget)for(let J=0;J<6;J++){if(Array.isArray(w.__webglFramebuffer[J]))for(let G=0;G<w.__webglFramebuffer[J].length;G++)i.deleteFramebuffer(w.__webglFramebuffer[J][G]);else i.deleteFramebuffer(w.__webglFramebuffer[J]);w.__webglDepthbuffer&&i.deleteRenderbuffer(w.__webglDepthbuffer[J])}else{if(Array.isArray(w.__webglFramebuffer))for(let J=0;J<w.__webglFramebuffer.length;J++)i.deleteFramebuffer(w.__webglFramebuffer[J]);else i.deleteFramebuffer(w.__webglFramebuffer);if(w.__webglDepthbuffer&&i.deleteRenderbuffer(w.__webglDepthbuffer),w.__webglMultisampledFramebuffer&&i.deleteFramebuffer(w.__webglMultisampledFramebuffer),w.__webglColorRenderbuffer)for(let J=0;J<w.__webglColorRenderbuffer.length;J++)w.__webglColorRenderbuffer[J]&&i.deleteRenderbuffer(w.__webglColorRenderbuffer[J]);w.__webglDepthRenderbuffer&&i.deleteRenderbuffer(w.__webglDepthRenderbuffer)}let q=P.textures;for(let J=0,G=q.length;J<G;J++){let re=n.get(q[J]);re.__webglTexture&&(i.deleteTexture(re.__webglTexture),o.memory.textures--),n.remove(q[J])}n.remove(P)}let D=0;function B(){D=0}function F(){return D}function L(P){D=P}function U(){let P=D;return P>=r.maxTextures&&Ge("WebGLTextures: Trying to use "+(P+1)+" texture units while this GPU supports only "+r.maxTextures),D+=1,P}function X(P){let w=[];return w.push(P.wrapS),w.push(P.wrapT),w.push(P.wrapR||0),w.push(P.magFilter),w.push(P.minFilter),w.push(P.anisotropy),w.push(P.internalFormat),w.push(P.format),w.push(P.type),w.push(P.generateMipmaps),w.push(P.premultiplyAlpha),w.push(P.flipY),w.push(P.unpackAlignment),w.push(P.colorSpace),w.join()}function te(P,w){let q=n.get(P);if(P.isVideoTexture&&z(P),P.isRenderTargetTexture===!1&&P.isExternalTexture!==!0&&P.version>0&&q.__version!==P.version){let J=P.image;if(J===null)Ge("WebGLRenderer: Texture marked for update but no image data found.");else if(J.complete===!1)Ge("WebGLRenderer: Texture marked for update but image is incomplete");else{Ce(q,P,w);return}}else P.isExternalTexture&&(q.__webglTexture=P.sourceTexture?P.sourceTexture:null);t.bindTexture(i.TEXTURE_2D,q.__webglTexture,i.TEXTURE0+w)}function Z(P,w){let q=n.get(P);if(P.isRenderTargetTexture===!1&&P.version>0&&q.__version!==P.version){Ce(q,P,w);return}else P.isExternalTexture&&(q.__webglTexture=P.sourceTexture?P.sourceTexture:null);t.bindTexture(i.TEXTURE_2D_ARRAY,q.__webglTexture,i.TEXTURE0+w)}function K(P,w){let q=n.get(P);if(P.isRenderTargetTexture===!1&&P.version>0&&q.__version!==P.version){Ce(q,P,w);return}t.bindTexture(i.TEXTURE_3D,q.__webglTexture,i.TEXTURE0+w)}function j(P,w){let q=n.get(P);if(P.isCubeDepthTexture!==!0&&P.version>0&&q.__version!==P.version){He(q,P,w);return}t.bindTexture(i.TEXTURE_CUBE_MAP,q.__webglTexture,i.TEXTURE0+w)}let ne={[Yr]:i.REPEAT,[zn]:i.CLAMP_TO_EDGE,[Fo]:i.MIRRORED_REPEAT},ie={[Kt]:i.NEAREST,[kf]:i.NEAREST_MIPMAP_NEAREST,[$s]:i.NEAREST_MIPMAP_LINEAR,[zt]:i.LINEAR,[Ma]:i.LINEAR_MIPMAP_NEAREST,[ki]:i.LINEAR_MIPMAP_LINEAR},We={[am]:i.NEVER,[fm]:i.ALWAYS,[lm]:i.LESS,[ou]:i.LEQUAL,[cm]:i.EQUAL,[au]:i.GEQUAL,[um]:i.GREATER,[hm]:i.NOTEQUAL};function Fe(P,w){if(w.type===Rn&&e.has("OES_texture_float_linear")===!1&&(w.magFilter===zt||w.magFilter===Ma||w.magFilter===$s||w.magFilter===ki||w.minFilter===zt||w.minFilter===Ma||w.minFilter===$s||w.minFilter===ki)&&Ge("WebGLRenderer: Unable to use linear filtering with floating point textures. OES_texture_float_linear not supported on this device."),i.texParameteri(P,i.TEXTURE_WRAP_S,ne[w.wrapS]),i.texParameteri(P,i.TEXTURE_WRAP_T,ne[w.wrapT]),(P===i.TEXTURE_3D||P===i.TEXTURE_2D_ARRAY)&&i.texParameteri(P,i.TEXTURE_WRAP_R,ne[w.wrapR]),i.texParameteri(P,i.TEXTURE_MAG_FILTER,ie[w.magFilter]),i.texParameteri(P,i.TEXTURE_MIN_FILTER,ie[w.minFilter]),w.compareFunction&&(i.texParameteri(P,i.TEXTURE_COMPARE_MODE,i.COMPARE_REF_TO_TEXTURE),i.texParameteri(P,i.TEXTURE_COMPARE_FUNC,We[w.compareFunction])),e.has("EXT_texture_filter_anisotropic")===!0){if(w.magFilter===Kt||w.minFilter!==$s&&w.minFilter!==ki||w.type===Rn&&e.has("OES_texture_float_linear")===!1)return;if(w.anisotropy>1||n.get(w).__currentAnisotropy){let q=e.get("EXT_texture_filter_anisotropic");i.texParameterf(P,q.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(w.anisotropy,r.getMaxAnisotropy())),n.get(w).__currentAnisotropy=w.anisotropy}}}function Ye(P,w){let q=!1;P.__webglInit===void 0&&(P.__webglInit=!0,w.addEventListener("dispose",E));let J=w.source,G=d.get(J);G===void 0&&(G={},d.set(J,G));let re=X(w);if(re!==P.__cacheKey){G[re]===void 0&&(G[re]={texture:i.createTexture(),usedTimes:0},o.memory.textures++,q=!0),G[re].usedTimes++;let Q=G[P.__cacheKey];Q!==void 0&&(G[P.__cacheKey].usedTimes--,Q.usedTimes===0&&A(w)),P.__cacheKey=re,P.__webglTexture=G[re].texture}return q}function $(P,w,q){return Math.floor(Math.floor(P/q)/w)}function oe(P,w,q,J){let re=P.updateRanges;if(re.length===0)t.texSubImage2D(i.TEXTURE_2D,0,0,0,w.width,w.height,q,J,w.data);else{re.sort((Se,me)=>Se.start-me.start);let Q=0;for(let Se=1;Se<re.length;Se++){let me=re[Q],_e=re[Se],ce=me.start+me.count,fe=$(_e.start,w.width,4),De=$(me.start,w.width,4);_e.start<=ce+1&&fe===De&&$(_e.start+_e.count-1,w.width,4)===fe?me.count=Math.max(me.count,_e.start+_e.count-me.start):(++Q,re[Q]=_e)}re.length=Q+1;let V=t.getParameter(i.UNPACK_ROW_LENGTH),ee=t.getParameter(i.UNPACK_SKIP_PIXELS),le=t.getParameter(i.UNPACK_SKIP_ROWS);t.pixelStorei(i.UNPACK_ROW_LENGTH,w.width);for(let Se=0,me=re.length;Se<me;Se++){let _e=re[Se],ce=Math.floor(_e.start/4),fe=Math.ceil(_e.count/4),De=ce%w.width,O=Math.floor(ce/w.width),Me=fe,se=1;t.pixelStorei(i.UNPACK_SKIP_PIXELS,De),t.pixelStorei(i.UNPACK_SKIP_ROWS,O),t.texSubImage2D(i.TEXTURE_2D,0,De,O,Me,se,q,J,w.data)}P.clearUpdateRanges(),t.pixelStorei(i.UNPACK_ROW_LENGTH,V),t.pixelStorei(i.UNPACK_SKIP_PIXELS,ee),t.pixelStorei(i.UNPACK_SKIP_ROWS,le)}}function Ce(P,w,q){let J=i.TEXTURE_2D;(w.isDataArrayTexture||w.isCompressedArrayTexture)&&(J=i.TEXTURE_2D_ARRAY),w.isData3DTexture&&(J=i.TEXTURE_3D);let G=Ye(P,w),re=w.source;t.bindTexture(J,P.__webglTexture,i.TEXTURE0+q);let Q=n.get(re);if(re.version!==Q.__version||G===!0){if(t.activeTexture(i.TEXTURE0+q),(typeof ImageBitmap<"u"&&w.image instanceof ImageBitmap)===!1){let se=vt.getPrimaries(vt.workingColorSpace),Pe=w.colorSpace===ir?null:vt.getPrimaries(w.colorSpace),Be=w.colorSpace===ir||se===Pe?i.NONE:i.BROWSER_DEFAULT_WEBGL;t.pixelStorei(i.UNPACK_FLIP_Y_WEBGL,w.flipY),t.pixelStorei(i.UNPACK_PREMULTIPLY_ALPHA_WEBGL,w.premultiplyAlpha),t.pixelStorei(i.UNPACK_COLORSPACE_CONVERSION_WEBGL,Be)}t.pixelStorei(i.UNPACK_ALIGNMENT,w.unpackAlignment);let ee=g(w.image,!1,r.maxTextureSize);ee=lt(w,ee);let le=s.convert(w.format,w.colorSpace),Se=s.convert(w.type),me=x(w.internalFormat,le,Se,w.normalized,w.colorSpace,w.isVideoTexture);Fe(J,w);let _e,ce=w.mipmaps,fe=w.isVideoTexture!==!0,De=Q.__version===void 0||G===!0,O=re.dataReady,Me=b(w,ee);if(w.isDepthTexture)me=S(w.format===Pr,w.type),De&&(fe?t.texStorage2D(i.TEXTURE_2D,1,me,ee.width,ee.height):t.texImage2D(i.TEXTURE_2D,0,me,ee.width,ee.height,0,le,Se,null));else if(w.isDataTexture)if(ce.length>0){fe&&De&&t.texStorage2D(i.TEXTURE_2D,Me,me,ce[0].width,ce[0].height);for(let se=0,Pe=ce.length;se<Pe;se++)_e=ce[se],fe?O&&t.texSubImage2D(i.TEXTURE_2D,se,0,0,_e.width,_e.height,le,Se,_e.data):t.texImage2D(i.TEXTURE_2D,se,me,_e.width,_e.height,0,le,Se,_e.data);w.generateMipmaps=!1}else fe?(De&&t.texStorage2D(i.TEXTURE_2D,Me,me,ee.width,ee.height),O&&oe(w,ee,le,Se)):t.texImage2D(i.TEXTURE_2D,0,me,ee.width,ee.height,0,le,Se,ee.data);else if(w.isCompressedTexture)if(w.isCompressedArrayTexture){fe&&De&&t.texStorage3D(i.TEXTURE_2D_ARRAY,Me,me,ce[0].width,ce[0].height,ee.depth);for(let se=0,Pe=ce.length;se<Pe;se++)if(_e=ce[se],w.format!==Pn)if(le!==null)if(fe){if(O)if(w.layerUpdates.size>0){let Be=Jf(_e.width,_e.height,w.format,w.type);for(let ue of w.layerUpdates){let je=_e.data.subarray(ue*Be/_e.data.BYTES_PER_ELEMENT,(ue+1)*Be/_e.data.BYTES_PER_ELEMENT);t.compressedTexSubImage3D(i.TEXTURE_2D_ARRAY,se,0,0,ue,_e.width,_e.height,1,le,je)}}else t.compressedTexSubImage3D(i.TEXTURE_2D_ARRAY,se,0,0,0,_e.width,_e.height,ee.depth,le,_e.data)}else t.compressedTexImage3D(i.TEXTURE_2D_ARRAY,se,me,_e.width,_e.height,ee.depth,0,_e.data,0,0);else Ge("WebGLRenderer: Attempt to load unsupported compressed texture format in .uploadTexture()");else fe?O&&t.texSubImage3D(i.TEXTURE_2D_ARRAY,se,0,0,0,_e.width,_e.height,ee.depth,le,Se,_e.data):t.texImage3D(i.TEXTURE_2D_ARRAY,se,me,_e.width,_e.height,ee.depth,0,le,Se,_e.data);w.layerUpdates.size>0&&w.clearLayerUpdates()}else{fe&&De&&t.texStorage2D(i.TEXTURE_2D,Me,me,ce[0].width,ce[0].height);for(let se=0,Pe=ce.length;se<Pe;se++)_e=ce[se],w.format!==Pn?le!==null?fe?O&&t.compressedTexSubImage2D(i.TEXTURE_2D,se,0,0,_e.width,_e.height,le,_e.data):t.compressedTexImage2D(i.TEXTURE_2D,se,me,_e.width,_e.height,0,_e.data):Ge("WebGLRenderer: Attempt to load unsupported compressed texture format in .uploadTexture()"):fe?O&&t.texSubImage2D(i.TEXTURE_2D,se,0,0,_e.width,_e.height,le,Se,_e.data):t.texImage2D(i.TEXTURE_2D,se,me,_e.width,_e.height,0,le,Se,_e.data)}else if(w.isDataArrayTexture)if(fe){if(De&&t.texStorage3D(i.TEXTURE_2D_ARRAY,Me,me,ee.width,ee.height,ee.depth),O)if(w.layerUpdates.size>0){let se=Jf(ee.width,ee.height,w.format,w.type);for(let Pe of w.layerUpdates){let Be=ee.data.subarray(Pe*se/ee.data.BYTES_PER_ELEMENT,(Pe+1)*se/ee.data.BYTES_PER_ELEMENT);t.texSubImage3D(i.TEXTURE_2D_ARRAY,0,0,0,Pe,ee.width,ee.height,1,le,Se,Be)}w.clearLayerUpdates()}else t.texSubImage3D(i.TEXTURE_2D_ARRAY,0,0,0,0,ee.width,ee.height,ee.depth,le,Se,ee.data)}else t.texImage3D(i.TEXTURE_2D_ARRAY,0,me,ee.width,ee.height,ee.depth,0,le,Se,ee.data);else if(w.isData3DTexture)fe?(De&&t.texStorage3D(i.TEXTURE_3D,Me,me,ee.width,ee.height,ee.depth),O&&t.texSubImage3D(i.TEXTURE_3D,0,0,0,0,ee.width,ee.height,ee.depth,le,Se,ee.data)):t.texImage3D(i.TEXTURE_3D,0,me,ee.width,ee.height,ee.depth,0,le,Se,ee.data);else if(w.isFramebufferTexture){if(De)if(fe)t.texStorage2D(i.TEXTURE_2D,Me,me,ee.width,ee.height);else{let se=ee.width,Pe=ee.height;for(let Be=0;Be<Me;Be++)t.texImage2D(i.TEXTURE_2D,Be,me,se,Pe,0,le,Se,null),se>>=1,Pe>>=1}}else if(w.isHTMLTexture){if("texElementImage2D"in i){let se=i.canvas;if(se.hasAttribute("layoutsubtree")||se.setAttribute("layoutsubtree","true"),ee.parentNode!==se){se.appendChild(ee),f.add(w),se.onpaint=Pe=>{let Be=Pe.changedElements;for(let ue of f)Be.includes(ue.image)&&(ue.needsUpdate=!0)},se.requestPaint();return}if(i.texElementImage2D.length===3)i.texElementImage2D(i.TEXTURE_2D,i.RGBA8,ee);else{let Be=i.RGBA,ue=i.RGBA,je=i.UNSIGNED_BYTE;i.texElementImage2D(i.TEXTURE_2D,0,Be,ue,je,ee)}i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MIN_FILTER,i.LINEAR),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_S,i.CLAMP_TO_EDGE),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_T,i.CLAMP_TO_EDGE)}}else if(ce.length>0){if(fe&&De){let se=rt(ce[0]);t.texStorage2D(i.TEXTURE_2D,Me,me,se.width,se.height)}for(let se=0,Pe=ce.length;se<Pe;se++)_e=ce[se],fe?O&&t.texSubImage2D(i.TEXTURE_2D,se,0,0,le,Se,_e):t.texImage2D(i.TEXTURE_2D,se,me,le,Se,_e);w.generateMipmaps=!1}else if(fe){if(De){let se=rt(ee);t.texStorage2D(i.TEXTURE_2D,Me,me,se.width,se.height)}O&&t.texSubImage2D(i.TEXTURE_2D,0,0,0,le,Se,ee)}else t.texImage2D(i.TEXTURE_2D,0,me,le,Se,ee);m(w)&&y(J),Q.__version=re.version,w.onUpdate&&w.onUpdate(w)}P.__version=w.version}function He(P,w,q){if(w.image.length!==6)return;let J=Ye(P,w),G=w.source;t.bindTexture(i.TEXTURE_CUBE_MAP,P.__webglTexture,i.TEXTURE0+q);let re=n.get(G);if(G.version!==re.__version||J===!0){t.activeTexture(i.TEXTURE0+q);let Q=vt.getPrimaries(vt.workingColorSpace),V=w.colorSpace===ir?null:vt.getPrimaries(w.colorSpace),ee=w.colorSpace===ir||Q===V?i.NONE:i.BROWSER_DEFAULT_WEBGL;t.pixelStorei(i.UNPACK_FLIP_Y_WEBGL,w.flipY),t.pixelStorei(i.UNPACK_PREMULTIPLY_ALPHA_WEBGL,w.premultiplyAlpha),t.pixelStorei(i.UNPACK_ALIGNMENT,w.unpackAlignment),t.pixelStorei(i.UNPACK_COLORSPACE_CONVERSION_WEBGL,ee);let le=w.isCompressedTexture||w.image[0].isCompressedTexture,Se=w.image[0]&&w.image[0].isDataTexture,me=[];for(let ue=0;ue<6;ue++)!le&&!Se?me[ue]=g(w.image[ue],!0,r.maxCubemapSize):me[ue]=Se?w.image[ue].image:w.image[ue],me[ue]=lt(w,me[ue]);let _e=me[0],ce=s.convert(w.format,w.colorSpace),fe=s.convert(w.type),De=x(w.internalFormat,ce,fe,w.normalized,w.colorSpace),O=w.isVideoTexture!==!0,Me=re.__version===void 0||J===!0,se=G.dataReady,Pe=b(w,_e);Fe(i.TEXTURE_CUBE_MAP,w);let Be;if(le){O&&Me&&t.texStorage2D(i.TEXTURE_CUBE_MAP,Pe,De,_e.width,_e.height);for(let ue=0;ue<6;ue++){Be=me[ue].mipmaps;for(let je=0;je<Be.length;je++){let Ze=Be[je];w.format!==Pn?ce!==null?O?se&&t.compressedTexSubImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+ue,je,0,0,Ze.width,Ze.height,ce,Ze.data):t.compressedTexImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+ue,je,De,Ze.width,Ze.height,0,Ze.data):Ge("WebGLRenderer: Attempt to load unsupported compressed texture format in .setTextureCube()"):O?se&&t.texSubImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+ue,je,0,0,Ze.width,Ze.height,ce,fe,Ze.data):t.texImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+ue,je,De,Ze.width,Ze.height,0,ce,fe,Ze.data)}}}else{if(Be=w.mipmaps,O&&Me){Be.length>0&&Pe++;let ue=rt(me[0]);t.texStorage2D(i.TEXTURE_CUBE_MAP,Pe,De,ue.width,ue.height)}for(let ue=0;ue<6;ue++)if(Se){O?se&&t.texSubImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+ue,0,0,0,me[ue].width,me[ue].height,ce,fe,me[ue].data):t.texImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+ue,0,De,me[ue].width,me[ue].height,0,ce,fe,me[ue].data);for(let je=0;je<Be.length;je++){let Mt=Be[je].image[ue].image;O?se&&t.texSubImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+ue,je+1,0,0,Mt.width,Mt.height,ce,fe,Mt.data):t.texImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+ue,je+1,De,Mt.width,Mt.height,0,ce,fe,Mt.data)}}else{O?se&&t.texSubImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+ue,0,0,0,ce,fe,me[ue]):t.texImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+ue,0,De,ce,fe,me[ue]);for(let je=0;je<Be.length;je++){let Ze=Be[je];O?se&&t.texSubImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+ue,je+1,0,0,ce,fe,Ze.image[ue]):t.texImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+ue,je+1,De,ce,fe,Ze.image[ue])}}}m(w)&&y(i.TEXTURE_CUBE_MAP),re.__version=G.version,w.onUpdate&&w.onUpdate(w)}P.__version=w.version}function Ee(P,w,q,J,G,re){let Q=s.convert(q.format,q.colorSpace),V=s.convert(q.type),ee=x(q.internalFormat,Q,V,q.normalized,q.colorSpace),le=n.get(w),Se=n.get(q);if(Se.__renderTarget=w,!le.__hasExternalTextures){let me=Math.max(1,w.width>>re),_e=Math.max(1,w.height>>re);G===i.TEXTURE_3D||G===i.TEXTURE_2D_ARRAY?t.texImage3D(G,re,ee,me,_e,w.depth,0,Q,V,null):t.texImage2D(G,re,ee,me,_e,0,Q,V,null)}t.bindFramebuffer(i.FRAMEBUFFER,P),Je(w)?a.framebufferTexture2DMultisampleEXT(i.FRAMEBUFFER,J,G,Se.__webglTexture,0,Re(w)):(G===i.TEXTURE_2D||G>=i.TEXTURE_CUBE_MAP_POSITIVE_X&&G<=i.TEXTURE_CUBE_MAP_NEGATIVE_Z)&&i.framebufferTexture2D(i.FRAMEBUFFER,J,G,Se.__webglTexture,re),t.bindFramebuffer(i.FRAMEBUFFER,null)}function ze(P,w,q){if(i.bindRenderbuffer(i.RENDERBUFFER,P),w.depthBuffer){let J=w.depthTexture,G=J&&J.isDepthTexture?J.type:null,re=S(w.stencilBuffer,G),Q=w.stencilBuffer?i.DEPTH_STENCIL_ATTACHMENT:i.DEPTH_ATTACHMENT;Je(w)?a.renderbufferStorageMultisampleEXT(i.RENDERBUFFER,Re(w),re,w.width,w.height):q?i.renderbufferStorageMultisample(i.RENDERBUFFER,Re(w),re,w.width,w.height):i.renderbufferStorage(i.RENDERBUFFER,re,w.width,w.height),i.framebufferRenderbuffer(i.FRAMEBUFFER,Q,i.RENDERBUFFER,P)}else{let J=w.textures;for(let G=0;G<J.length;G++){let re=J[G],Q=s.convert(re.format,re.colorSpace),V=s.convert(re.type),ee=x(re.internalFormat,Q,V,re.normalized,re.colorSpace);Je(w)?a.renderbufferStorageMultisampleEXT(i.RENDERBUFFER,Re(w),ee,w.width,w.height):q?i.renderbufferStorageMultisample(i.RENDERBUFFER,Re(w),ee,w.width,w.height):i.renderbufferStorage(i.RENDERBUFFER,ee,w.width,w.height)}}i.bindRenderbuffer(i.RENDERBUFFER,null)}function pt(P,w,q){let J=w.isWebGLCubeRenderTarget===!0;if(t.bindFramebuffer(i.FRAMEBUFFER,P),!(w.depthTexture&&w.depthTexture.isDepthTexture))throw new Error("THREE.WebGLTextures: renderTarget.depthTexture must be an instance of THREE.DepthTexture.");let G=n.get(w.depthTexture);if(G.__renderTarget=w,(!G.__webglTexture||w.depthTexture.image.width!==w.width||w.depthTexture.image.height!==w.height)&&(w.depthTexture.image.width=w.width,w.depthTexture.image.height=w.height,w.depthTexture.needsUpdate=!0),J){if(G.__webglInit===void 0&&(G.__webglInit=!0,w.depthTexture.addEventListener("dispose",E)),G.__webglTexture===void 0){G.__webglTexture=i.createTexture(),t.bindTexture(i.TEXTURE_CUBE_MAP,G.__webglTexture),Fe(i.TEXTURE_CUBE_MAP,w.depthTexture);let le=s.convert(w.depthTexture.format),Se=s.convert(w.depthTexture.type),me;w.depthTexture.format===Ui?me=i.DEPTH_COMPONENT24:w.depthTexture.format===Pr&&(me=i.DEPTH24_STENCIL8);for(let _e=0;_e<6;_e++)i.texImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+_e,0,me,w.width,w.height,0,le,Se,null)}}else te(w.depthTexture,0);let re=G.__webglTexture,Q=Re(w),V=J?i.TEXTURE_CUBE_MAP_POSITIVE_X+q:i.TEXTURE_2D,ee=w.depthTexture.format===Pr?i.DEPTH_STENCIL_ATTACHMENT:i.DEPTH_ATTACHMENT;if(w.depthTexture.format===Ui)Je(w)?a.framebufferTexture2DMultisampleEXT(i.FRAMEBUFFER,ee,V,re,0,Q):i.framebufferTexture2D(i.FRAMEBUFFER,ee,V,re,0);else if(w.depthTexture.format===Pr)Je(w)?a.framebufferTexture2DMultisampleEXT(i.FRAMEBUFFER,ee,V,re,0,Q):i.framebufferTexture2D(i.FRAMEBUFFER,ee,V,re,0);else throw new Error("THREE.WebGLTextures: Unknown depthTexture format.")}function ae(P){let w=n.get(P),q=P.isWebGLCubeRenderTarget===!0;if(w.__boundDepthTexture!==P.depthTexture){let J=P.depthTexture;if(w.__depthDisposeCallback&&w.__depthDisposeCallback(),J){let G=()=>{delete w.__boundDepthTexture,delete w.__depthDisposeCallback,J.removeEventListener("dispose",G)};J.addEventListener("dispose",G),w.__depthDisposeCallback=G}w.__boundDepthTexture=J}if(P.depthTexture&&!w.__autoAllocateDepthBuffer)if(q)for(let J=0;J<6;J++)pt(w.__webglFramebuffer[J],P,J);else{let J=P.texture.mipmaps;J&&J.length>0?pt(w.__webglFramebuffer[0],P,0):pt(w.__webglFramebuffer,P,0)}else if(q){w.__webglDepthbuffer=[];for(let J=0;J<6;J++)if(t.bindFramebuffer(i.FRAMEBUFFER,w.__webglFramebuffer[J]),w.__webglDepthbuffer[J]===void 0)w.__webglDepthbuffer[J]=i.createRenderbuffer(),ze(w.__webglDepthbuffer[J],P,!1);else{let G=P.stencilBuffer?i.DEPTH_STENCIL_ATTACHMENT:i.DEPTH_ATTACHMENT,re=w.__webglDepthbuffer[J];i.bindRenderbuffer(i.RENDERBUFFER,re),i.framebufferRenderbuffer(i.FRAMEBUFFER,G,i.RENDERBUFFER,re)}}else{let J=P.texture.mipmaps;if(J&&J.length>0?t.bindFramebuffer(i.FRAMEBUFFER,w.__webglFramebuffer[0]):t.bindFramebuffer(i.FRAMEBUFFER,w.__webglFramebuffer),w.__webglDepthbuffer===void 0)w.__webglDepthbuffer=i.createRenderbuffer(),ze(w.__webglDepthbuffer,P,!1);else{let G=P.stencilBuffer?i.DEPTH_STENCIL_ATTACHMENT:i.DEPTH_ATTACHMENT,re=w.__webglDepthbuffer;i.bindRenderbuffer(i.RENDERBUFFER,re),i.framebufferRenderbuffer(i.FRAMEBUFFER,G,i.RENDERBUFFER,re)}}t.bindFramebuffer(i.FRAMEBUFFER,null)}function xe(P,w,q){let J=n.get(P);w!==void 0&&Ee(J.__webglFramebuffer,P,P.texture,i.COLOR_ATTACHMENT0,i.TEXTURE_2D,0),q!==void 0&&ae(P)}function we(P){let w=P.texture,q=n.get(P),J=n.get(w);P.addEventListener("dispose",M);let G=P.textures,re=P.isWebGLCubeRenderTarget===!0,Q=G.length>1;if(Q||(J.__webglTexture===void 0&&(J.__webglTexture=i.createTexture()),J.__version=w.version,o.memory.textures++),re){q.__webglFramebuffer=[];for(let V=0;V<6;V++)if(w.mipmaps&&w.mipmaps.length>0){q.__webglFramebuffer[V]=[];for(let ee=0;ee<w.mipmaps.length;ee++)q.__webglFramebuffer[V][ee]=i.createFramebuffer()}else q.__webglFramebuffer[V]=i.createFramebuffer()}else{if(w.mipmaps&&w.mipmaps.length>0){q.__webglFramebuffer=[];for(let V=0;V<w.mipmaps.length;V++)q.__webglFramebuffer[V]=i.createFramebuffer()}else q.__webglFramebuffer=i.createFramebuffer();if(Q)for(let V=0,ee=G.length;V<ee;V++){let le=n.get(G[V]);le.__webglTexture===void 0&&(le.__webglTexture=i.createTexture(),o.memory.textures++)}if(P.samples>0&&Je(P)===!1){q.__webglMultisampledFramebuffer=i.createFramebuffer(),q.__webglColorRenderbuffer=[],t.bindFramebuffer(i.FRAMEBUFFER,q.__webglMultisampledFramebuffer);for(let V=0;V<G.length;V++){let ee=G[V];q.__webglColorRenderbuffer[V]=i.createRenderbuffer(),i.bindRenderbuffer(i.RENDERBUFFER,q.__webglColorRenderbuffer[V]);let le=s.convert(ee.format,ee.colorSpace),Se=s.convert(ee.type),me=x(ee.internalFormat,le,Se,ee.normalized,ee.colorSpace,P.isXRRenderTarget===!0),_e=Re(P);i.renderbufferStorageMultisample(i.RENDERBUFFER,_e,me,P.width,P.height),i.framebufferRenderbuffer(i.FRAMEBUFFER,i.COLOR_ATTACHMENT0+V,i.RENDERBUFFER,q.__webglColorRenderbuffer[V])}i.bindRenderbuffer(i.RENDERBUFFER,null),P.depthBuffer&&(q.__webglDepthRenderbuffer=i.createRenderbuffer(),ze(q.__webglDepthRenderbuffer,P,!0)),t.bindFramebuffer(i.FRAMEBUFFER,null)}}if(re){t.bindTexture(i.TEXTURE_CUBE_MAP,J.__webglTexture),Fe(i.TEXTURE_CUBE_MAP,w);for(let V=0;V<6;V++)if(w.mipmaps&&w.mipmaps.length>0)for(let ee=0;ee<w.mipmaps.length;ee++)Ee(q.__webglFramebuffer[V][ee],P,w,i.COLOR_ATTACHMENT0,i.TEXTURE_CUBE_MAP_POSITIVE_X+V,ee);else Ee(q.__webglFramebuffer[V],P,w,i.COLOR_ATTACHMENT0,i.TEXTURE_CUBE_MAP_POSITIVE_X+V,0);m(w)&&y(i.TEXTURE_CUBE_MAP),t.unbindTexture()}else if(Q){for(let V=0,ee=G.length;V<ee;V++){let le=G[V],Se=n.get(le),me=i.TEXTURE_2D;(P.isWebGL3DRenderTarget||P.isWebGLArrayRenderTarget)&&(me=P.isWebGL3DRenderTarget?i.TEXTURE_3D:i.TEXTURE_2D_ARRAY),t.bindTexture(me,Se.__webglTexture),Fe(me,le),Ee(q.__webglFramebuffer,P,le,i.COLOR_ATTACHMENT0+V,me,0),m(le)&&y(me)}t.unbindTexture()}else{let V=i.TEXTURE_2D;if((P.isWebGL3DRenderTarget||P.isWebGLArrayRenderTarget)&&(V=P.isWebGL3DRenderTarget?i.TEXTURE_3D:i.TEXTURE_2D_ARRAY),t.bindTexture(V,J.__webglTexture),Fe(V,w),w.mipmaps&&w.mipmaps.length>0)for(let ee=0;ee<w.mipmaps.length;ee++)Ee(q.__webglFramebuffer[ee],P,w,i.COLOR_ATTACHMENT0,V,ee);else Ee(q.__webglFramebuffer,P,w,i.COLOR_ATTACHMENT0,V,0);m(w)&&y(V),t.unbindTexture()}P.depthBuffer&&ae(P)}function Ae(P){let w=P.textures;for(let q=0,J=w.length;q<J;q++){let G=w[q];if(m(G)){let re=_(P),Q=n.get(G).__webglTexture;t.bindTexture(re,Q),y(re),t.unbindTexture()}}}let Te=[],de=[];function Oe(P){if(P.samples>0){if(Je(P)===!1){let w=P.textures,q=P.width,J=P.height,G=i.COLOR_BUFFER_BIT,re=P.stencilBuffer?i.DEPTH_STENCIL_ATTACHMENT:i.DEPTH_ATTACHMENT,Q=n.get(P),V=w.length>1;if(V)for(let le=0;le<w.length;le++)t.bindFramebuffer(i.FRAMEBUFFER,Q.__webglMultisampledFramebuffer),i.framebufferRenderbuffer(i.FRAMEBUFFER,i.COLOR_ATTACHMENT0+le,i.RENDERBUFFER,null),t.bindFramebuffer(i.FRAMEBUFFER,Q.__webglFramebuffer),i.framebufferTexture2D(i.DRAW_FRAMEBUFFER,i.COLOR_ATTACHMENT0+le,i.TEXTURE_2D,null,0);t.bindFramebuffer(i.READ_FRAMEBUFFER,Q.__webglMultisampledFramebuffer);let ee=P.texture.mipmaps;ee&&ee.length>0?t.bindFramebuffer(i.DRAW_FRAMEBUFFER,Q.__webglFramebuffer[0]):t.bindFramebuffer(i.DRAW_FRAMEBUFFER,Q.__webglFramebuffer);for(let le=0;le<w.length;le++){if(P.resolveDepthBuffer&&(P.depthBuffer&&(G|=i.DEPTH_BUFFER_BIT),P.stencilBuffer&&P.resolveStencilBuffer&&(G|=i.STENCIL_BUFFER_BIT)),V){i.framebufferRenderbuffer(i.READ_FRAMEBUFFER,i.COLOR_ATTACHMENT0,i.RENDERBUFFER,Q.__webglColorRenderbuffer[le]);let Se=n.get(w[le]).__webglTexture;i.framebufferTexture2D(i.DRAW_FRAMEBUFFER,i.COLOR_ATTACHMENT0,i.TEXTURE_2D,Se,0)}i.blitFramebuffer(0,0,q,J,0,0,q,J,G,i.NEAREST),l===!0&&(Te.length=0,de.length=0,Te.push(i.COLOR_ATTACHMENT0+le),P.depthBuffer&&P.storeMultisampledDepthBuffer===!1&&(Te.push(re),de.push(re),i.invalidateFramebuffer(i.DRAW_FRAMEBUFFER,de)),i.invalidateFramebuffer(i.READ_FRAMEBUFFER,Te))}if(t.bindFramebuffer(i.READ_FRAMEBUFFER,null),t.bindFramebuffer(i.DRAW_FRAMEBUFFER,null),V)for(let le=0;le<w.length;le++){t.bindFramebuffer(i.FRAMEBUFFER,Q.__webglMultisampledFramebuffer),i.framebufferRenderbuffer(i.FRAMEBUFFER,i.COLOR_ATTACHMENT0+le,i.RENDERBUFFER,Q.__webglColorRenderbuffer[le]);let Se=n.get(w[le]).__webglTexture;t.bindFramebuffer(i.FRAMEBUFFER,Q.__webglFramebuffer),i.framebufferTexture2D(i.DRAW_FRAMEBUFFER,i.COLOR_ATTACHMENT0+le,i.TEXTURE_2D,Se,0)}t.bindFramebuffer(i.DRAW_FRAMEBUFFER,Q.__webglMultisampledFramebuffer)}else if(P.depthBuffer&&P.storeMultisampledDepthBuffer===!1&&l){let w=P.stencilBuffer?i.DEPTH_STENCIL_ATTACHMENT:i.DEPTH_ATTACHMENT;i.invalidateFramebuffer(i.DRAW_FRAMEBUFFER,[w])}}}function Re(P){return Math.min(r.maxSamples,P.samples)}function Je(P){let w=n.get(P);return P.samples>0&&e.has("WEBGL_multisampled_render_to_texture")===!0&&w.__useRenderToTexture!==!1}function z(P){let w=o.render.frame;u.get(P)!==w&&(u.set(P,w),P.update())}function lt(P,w){let q=P.colorSpace,J=P.format,G=P.type;return P.isCompressedTexture===!0||P.isVideoTexture===!0||q!==Oo&&q!==ir&&(vt.getTransfer(q)===bt?(J!==Pn||G!==Xn)&&Ge("WebGLTextures: sRGB encoded textures have to use RGBAFormat and UnsignedByteType."):Qe("WebGLTextures: Unsupported texture color space:",q)),w}function rt(P){return typeof HTMLImageElement<"u"&&P instanceof HTMLImageElement?(c.width=P.naturalWidth||P.width,c.height=P.naturalHeight||P.height):typeof VideoFrame<"u"&&P instanceof VideoFrame?(c.width=P.displayWidth,c.height=P.displayHeight):(c.width=P.width,c.height=P.height),c}this.allocateTextureUnit=U,this.resetTextureUnits=B,this.getTextureUnits=F,this.setTextureUnits=L,this.setTexture2D=te,this.setTexture2DArray=Z,this.setTexture3D=K,this.setTextureCube=j,this.rebindTextures=xe,this.setupRenderTarget=we,this.updateRenderTargetMipmap=Ae,this.updateMultisampleRenderTarget=Oe,this.setupDepthRenderbuffer=ae,this.setupFrameBufferTexture=Ee,this.useMultisampledRTT=Je,this.isReversedDepthBuffer=function(){return t.buffers.depth.getReversed()}}function fx(i,e){function t(n,r=ir){let s,o=vt.getTransfer(r);if(n===Xn)return i.UNSIGNED_BYTE;if(n===wc)return i.UNSIGNED_SHORT_4_4_4_4;if(n===Tc)return i.UNSIGNED_SHORT_5_5_5_1;if(n===Hf)return i.UNSIGNED_INT_5_9_9_9_REV;if(n===Wf)return i.UNSIGNED_INT_10F_11F_11F_REV;if(n===Gf)return i.BYTE;if(n===Vf)return i.SHORT;if(n===Js)return i.UNSIGNED_SHORT;if(n===bc)return i.INT;if(n===hi)return i.UNSIGNED_INT;if(n===Rn)return i.FLOAT;if(n===ln)return i.HALF_FLOAT;if(n===Xf)return i.ALPHA;if(n===qf)return i.RGB;if(n===Pn)return i.RGBA;if(n===Ui)return i.DEPTH_COMPONENT;if(n===Pr)return i.DEPTH_STENCIL;if(n===Ac)return i.RED;if(n===Sa)return i.RED_INTEGER;if(n===Ir)return i.RG;if(n===Ec)return i.RG_INTEGER;if(n===Cc)return i.RGBA_INTEGER;if(n===ba||n===wa||n===Ta||n===Aa)if(o===bt)if(s=e.get("WEBGL_compressed_texture_s3tc_srgb"),s!==null){if(n===ba)return s.COMPRESSED_SRGB_S3TC_DXT1_EXT;if(n===wa)return s.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT;if(n===Ta)return s.COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT;if(n===Aa)return s.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT}else return null;else if(s=e.get("WEBGL_compressed_texture_s3tc"),s!==null){if(n===ba)return s.COMPRESSED_RGB_S3TC_DXT1_EXT;if(n===wa)return s.COMPRESSED_RGBA_S3TC_DXT1_EXT;if(n===Ta)return s.COMPRESSED_RGBA_S3TC_DXT3_EXT;if(n===Aa)return s.COMPRESSED_RGBA_S3TC_DXT5_EXT}else return null;if(n===Rc||n===Pc||n===Ic||n===Lc)if(s=e.get("WEBGL_compressed_texture_pvrtc"),s!==null){if(n===Rc)return s.COMPRESSED_RGB_PVRTC_4BPPV1_IMG;if(n===Pc)return s.COMPRESSED_RGB_PVRTC_2BPPV1_IMG;if(n===Ic)return s.COMPRESSED_RGBA_PVRTC_4BPPV1_IMG;if(n===Lc)return s.COMPRESSED_RGBA_PVRTC_2BPPV1_IMG}else return null;if(n===Dc||n===Nc||n===Fc||n===Uc||n===Bc||n===Ea||n===Oc)if(s=e.get("WEBGL_compressed_texture_etc"),s!==null){if(n===Dc||n===Nc)return o===bt?s.COMPRESSED_SRGB8_ETC2:s.COMPRESSED_RGB8_ETC2;if(n===Fc)return o===bt?s.COMPRESSED_SRGB8_ALPHA8_ETC2_EAC:s.COMPRESSED_RGBA8_ETC2_EAC;if(n===Uc)return s.COMPRESSED_R11_EAC;if(n===Bc)return s.COMPRESSED_SIGNED_R11_EAC;if(n===Ea)return s.COMPRESSED_RG11_EAC;if(n===Oc)return s.COMPRESSED_SIGNED_RG11_EAC}else return null;if(n===zc||n===kc||n===Gc||n===Vc||n===Hc||n===Wc||n===Xc||n===qc||n===Yc||n===Zc||n===$c||n===Jc||n===Kc||n===jc)if(s=e.get("WEBGL_compressed_texture_astc"),s!==null){if(n===zc)return o===bt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR:s.COMPRESSED_RGBA_ASTC_4x4_KHR;if(n===kc)return o===bt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_5x4_KHR:s.COMPRESSED_RGBA_ASTC_5x4_KHR;if(n===Gc)return o===bt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_5x5_KHR:s.COMPRESSED_RGBA_ASTC_5x5_KHR;if(n===Vc)return o===bt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_6x5_KHR:s.COMPRESSED_RGBA_ASTC_6x5_KHR;if(n===Hc)return o===bt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_6x6_KHR:s.COMPRESSED_RGBA_ASTC_6x6_KHR;if(n===Wc)return o===bt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_8x5_KHR:s.COMPRESSED_RGBA_ASTC_8x5_KHR;if(n===Xc)return o===bt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_8x6_KHR:s.COMPRESSED_RGBA_ASTC_8x6_KHR;if(n===qc)return o===bt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_8x8_KHR:s.COMPRESSED_RGBA_ASTC_8x8_KHR;if(n===Yc)return o===bt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_10x5_KHR:s.COMPRESSED_RGBA_ASTC_10x5_KHR;if(n===Zc)return o===bt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_10x6_KHR:s.COMPRESSED_RGBA_ASTC_10x6_KHR;if(n===$c)return o===bt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_10x8_KHR:s.COMPRESSED_RGBA_ASTC_10x8_KHR;if(n===Jc)return o===bt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_10x10_KHR:s.COMPRESSED_RGBA_ASTC_10x10_KHR;if(n===Kc)return o===bt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_12x10_KHR:s.COMPRESSED_RGBA_ASTC_12x10_KHR;if(n===jc)return o===bt?s.COMPRESSED_SRGB8_ALPHA8_ASTC_12x12_KHR:s.COMPRESSED_RGBA_ASTC_12x12_KHR}else return null;if(n===Qc||n===eu||n===tu)if(s=e.get("EXT_texture_compression_bptc"),s!==null){if(n===Qc)return o===bt?s.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT:s.COMPRESSED_RGBA_BPTC_UNORM_EXT;if(n===eu)return s.COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT;if(n===tu)return s.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT}else return null;if(n===nu||n===iu||n===Ca||n===ru)if(s=e.get("EXT_texture_compression_rgtc"),s!==null){if(n===nu)return s.COMPRESSED_RED_RGTC1_EXT;if(n===iu)return s.COMPRESSED_SIGNED_RED_RGTC1_EXT;if(n===Ca)return s.COMPRESSED_RED_GREEN_RGTC2_EXT;if(n===ru)return s.COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT}else return null;return n===Ks?i.UNSIGNED_INT_24_8:i[n]!==void 0?i[n]:null}return{convert:t}}var u2=`
void main() {

	gl_Position = vec4( position, 1.0 );

}`,h2=`
uniform sampler2DArray depthColor;
uniform float depthWidth;
uniform float depthHeight;

void main() {

	vec2 coord = vec2( gl_FragCoord.x / depthWidth, gl_FragCoord.y / depthHeight );

	if ( coord.x >= 1.0 ) {

		gl_FragDepth = texture( depthColor, vec3( coord.x - 1.0, coord.y, 1 ) ).r;

	} else {

		gl_FragDepth = texture( depthColor, vec3( coord.x, coord.y, 0 ) ).r;

	}

}`,Om=class{constructor(){this.texture=null,this.mesh=null,this.depthNear=0,this.depthFar=0}init(e,t){if(this.texture===null){let n=new $o(e.texture);(e.depthNear!==t.depthNear||e.depthFar!==t.depthFar)&&(this.depthNear=e.depthNear,this.depthFar=e.depthFar),this.texture=n}}getMesh(e){if(this.texture!==null&&this.mesh===null){let t=e.cameras[0].viewport,n=new Lt({vertexShader:u2,fragmentShader:h2,uniforms:{depthColor:{value:this.texture},depthWidth:{value:t.z},depthHeight:{value:t.w}}});this.mesh=new at(new ji(20,20),n)}return this.mesh}reset(){this.texture=null,this.mesh=null}getDepthTexture(){return this.texture}},zm=class extends jn{constructor(e,t){super();let n=this,r=null,s=1,o=null,a="local-floor",l=1,c=null,u=null,f=null,h=null,d=null,p=null,v=typeof XRWebGLBinding<"u",g=new Om,m={},y=t.getContextAttributes(),_=null,x=null,S=[],b=[],E=new he,M=null,T=null,A=new Ft;A.viewport=new Pt;let I=new Ft;I.viewport=new Pt;let D=[A,I],B=new vc,F=null,L=null;this.cameraAutoUpdate=!0,this.enabled=!1,this.isPresenting=!1,this.getController=function($){let oe=S[$];return oe===void 0&&(oe=new Rs,S[$]=oe),oe.getTargetRaySpace()},this.getControllerGrip=function($){let oe=S[$];return oe===void 0&&(oe=new Rs,S[$]=oe),oe.getGripSpace()},this.getHand=function($){let oe=S[$];return oe===void 0&&(oe=new Rs,S[$]=oe),oe.getHandSpace()};function U($){let oe=b.indexOf($.inputSource);if(oe===-1)return;let Ce=S[oe];Ce!==void 0&&(Ce.update($.inputSource,$.frame,c||o),Ce.dispatchEvent({type:$.type,data:$.inputSource}))}function X(){r.removeEventListener("select",U),r.removeEventListener("selectstart",U),r.removeEventListener("selectend",U),r.removeEventListener("squeeze",U),r.removeEventListener("squeezestart",U),r.removeEventListener("squeezeend",U),r.removeEventListener("end",X),r.removeEventListener("inputsourceschange",te);for(let $=0;$<S.length;$++){let oe=b[$];oe!==null&&(b[$]=null,S[$].disconnect(oe))}F=null,L=null,g.reset();for(let $ in m)delete m[$];if(e.setRenderTarget(_),d=null,h=null,f=null,r=null,x=null,Ye.stop(),n.isPresenting=!1,e.setPixelRatio(M),e.setSize(E.width,E.height,!1),T!==null){let $=T.camera;$.fov=T.fov,$.zoom=T.zoom,$.updateProjectionMatrix(),T=null}n.dispatchEvent({type:"sessionend"})}this.setFramebufferScaleFactor=function($){s=$,n.isPresenting===!0&&Ge("WebXRManager: Cannot change framebuffer scale while presenting.")},this.setReferenceSpaceType=function($){a=$,n.isPresenting===!0&&Ge("WebXRManager: Cannot change reference space type while presenting.")},this.getReferenceSpace=function(){return c||o},this.setReferenceSpace=function($){c=$},this.getBaseLayer=function(){return h!==null?h:d},this.getBinding=function(){return f===null&&v&&(f=new XRWebGLBinding(r,t)),f},this.getFrame=function(){return p},this.getSession=function(){return r},this.setSession=async function($){if(r=$,r!==null){if(_=e.getRenderTarget(),r.addEventListener("select",U),r.addEventListener("selectstart",U),r.addEventListener("selectend",U),r.addEventListener("squeeze",U),r.addEventListener("squeezestart",U),r.addEventListener("squeezeend",U),r.addEventListener("end",X),r.addEventListener("inputsourceschange",te),y.xrCompatible!==!0&&await t.makeXRCompatible(),M=e.getPixelRatio(),e.getSize(E),v&&"createProjectionLayer"in XRWebGLBinding.prototype){let Ce=null,He=null,Ee=null;y.depth&&(Ee=y.stencil?t.DEPTH24_STENCIL8:t.DEPTH_COMPONENT24,Ce=y.stencil?Pr:Ui,He=y.stencil?Ks:hi);let ze={colorFormat:t.RGBA8,depthFormat:Ee,scaleFactor:s};f=this.getBinding(),h=f.createProjectionLayer(ze),r.updateRenderState({layers:[h]}),e.setPixelRatio(1),e.setSize(h.textureWidth,h.textureHeight,!1),x=new Gt(h.textureWidth,h.textureHeight,{format:Pn,type:Xn,depthTexture:new Sr(h.textureWidth,h.textureHeight,He,void 0,void 0,void 0,void 0,void 0,void 0,Ce),stencilBuffer:y.stencil,colorSpace:e.outputColorSpace,samples:y.antialias?4:0,resolveDepthBuffer:h.ignoreDepthValues===!1,resolveStencilBuffer:h.ignoreDepthValues===!1,storeMultisampledDepthBuffer:h.ignoreDepthValues===!1,storeMultisampledStencilBuffer:h.ignoreDepthValues===!1})}else{let Ce={antialias:y.antialias,alpha:!0,depth:y.depth,stencil:y.stencil,framebufferScaleFactor:s};d=new XRWebGLLayer(r,t,Ce),r.updateRenderState({baseLayer:d}),e.setPixelRatio(1),e.setSize(d.framebufferWidth,d.framebufferHeight,!1),x=new Gt(d.framebufferWidth,d.framebufferHeight,{format:Pn,type:Xn,colorSpace:e.outputColorSpace,stencilBuffer:y.stencil,resolveDepthBuffer:d.ignoreDepthValues===!1,resolveStencilBuffer:d.ignoreDepthValues===!1,storeMultisampledDepthBuffer:d.ignoreDepthValues===!1,storeMultisampledStencilBuffer:d.ignoreDepthValues===!1})}x.isXRRenderTarget=!0,this.setFoveation(l),c=null,o=await r.requestReferenceSpace(a),Ye.setContext(r),Ye.start(),n.isPresenting=!0,n.dispatchEvent({type:"sessionstart"})}},this.getEnvironmentBlendMode=function(){if(r!==null)return r.environmentBlendMode},this.getDepthTexture=function(){return g.getDepthTexture()};function te($){for(let oe=0;oe<$.removed.length;oe++){let Ce=$.removed[oe],He=b.indexOf(Ce);He>=0&&(b[He]=null,S[He].disconnect(Ce))}for(let oe=0;oe<$.added.length;oe++){let Ce=$.added[oe],He=b.indexOf(Ce);if(He===-1){for(let ze=0;ze<S.length;ze++)if(ze>=b.length){b.push(Ce),He=ze;break}else if(b[ze]===null){b[ze]=Ce,He=ze;break}if(He===-1)break}let Ee=S[He];Ee&&Ee.connect(Ce)}}let Z=new R,K=new R;function j($,oe,Ce){Z.setFromMatrixPosition(oe.matrixWorld),K.setFromMatrixPosition(Ce.matrixWorld);let He=Z.distanceTo(K),Ee=oe.projectionMatrix.elements,ze=Ce.projectionMatrix.elements,pt=Ee[14]/(Ee[10]-1),ae=Ee[14]/(Ee[10]+1),xe=(Ee[9]+1)/Ee[5],we=(Ee[9]-1)/Ee[5],Ae=(Ee[8]-1)/Ee[0],Te=(ze[8]+1)/ze[0],de=pt*Ae,Oe=pt*Te,Re=He/(-Ae+Te),Je=Re*-Ae;if(oe.matrixWorld.decompose($.position,$.quaternion,$.scale),$.translateX(Je),$.translateZ(Re),$.matrixWorld.compose($.position,$.quaternion,$.scale),$.matrixWorldInverse.copy($.matrixWorld).invert(),Ee[10]===-1)$.projectionMatrix.copy(oe.projectionMatrix),$.projectionMatrixInverse.copy(oe.projectionMatrixInverse);else{let z=pt+Re,lt=ae+Re,rt=de-Je,P=Oe+(He-Je),w=xe*ae/lt*z,q=we*ae/lt*z;$.projectionMatrix.makePerspective(rt,P,w,q,z,lt),$.projectionMatrixInverse.copy($.projectionMatrix).invert()}}function ne($,oe){oe===null?$.matrixWorld.copy($.matrix):$.matrixWorld.multiplyMatrices(oe.matrixWorld,$.matrix),$.matrixWorldInverse.copy($.matrixWorld).invert()}this.updateCamera=function($){if(r===null)return;let oe=$.near,Ce=$.far;g.texture!==null&&(g.depthNear>0&&(oe=g.depthNear),g.depthFar>0&&(Ce=g.depthFar)),B.near=I.near=A.near=oe,B.far=I.far=A.far=Ce,(F!==B.near||L!==B.far)&&(r.updateRenderState({depthNear:B.near,depthFar:B.far}),F=B.near,L=B.far),B.layers.mask=$.layers.mask|6,A.layers.mask=B.layers.mask&-5,I.layers.mask=B.layers.mask&-3;let He=$.parent,Ee=B.cameras;ne(B,He);for(let ze=0;ze<Ee.length;ze++)ne(Ee[ze],He);Ee.length===2?j(B,A,I):B.projectionMatrix.copy(A.projectionMatrix),T===null&&$.isPerspectiveCamera&&(T={camera:$,fov:$.fov,zoom:$.zoom}),ie($,B,He)};function ie($,oe,Ce){Ce===null?$.matrix.copy(oe.matrixWorld):($.matrix.copy(Ce.matrixWorld),$.matrix.invert(),$.matrix.multiply(oe.matrixWorld)),$.matrix.decompose($.position,$.quaternion,$.scale),$.updateMatrixWorld(!0),$.projectionMatrix.copy(oe.projectionMatrix),$.projectionMatrixInverse.copy(oe.projectionMatrixInverse),$.isPerspectiveCamera&&($.fov=Ts*2*Math.atan(1/$.projectionMatrix.elements[5]),$.zoom=1)}this.getCamera=function(){return B},this.getFoveation=function(){if(!(h===null&&d===null))return l},this.setFoveation=function($){l=$,h!==null&&(h.fixedFoveation=$),d!==null&&d.fixedFoveation!==void 0&&(d.fixedFoveation=$)},this.hasDepthSensing=function(){return g.texture!==null},this.getDepthSensingMesh=function(){return g.getMesh(B)},this.getCameraTexture=function($){return m[$]};let We=null;function Fe($,oe){if(u=oe.getViewerPose(c||o),p=oe,u!==null){let Ce=u.views;d!==null&&(e.setRenderTargetFramebuffer(x,d.framebuffer),e.setRenderTarget(x));let He=!1;Ce.length!==B.cameras.length&&(B.cameras.length=0,He=!0);for(let ae=0;ae<Ce.length;ae++){let xe=Ce[ae],we=null;if(d!==null)we=d.getViewport(xe);else{let Te=f.getViewSubImage(h,xe);we=Te.viewport,ae===0&&(e.setRenderTargetTextures(x,Te.colorTexture,Te.depthStencilTexture),e.setRenderTarget(x))}let Ae=D[ae];Ae===void 0&&(Ae=new Ft,Ae.layers.enable(ae),Ae.viewport=new Pt,D[ae]=Ae),Ae.matrix.fromArray(xe.transform.matrix),Ae.matrix.decompose(Ae.position,Ae.quaternion,Ae.scale),Ae.projectionMatrix.fromArray(xe.projectionMatrix),Ae.projectionMatrixInverse.copy(Ae.projectionMatrix).invert(),Ae.viewport.set(we.x,we.y,we.width,we.height),ae===0&&(B.matrix.copy(Ae.matrix),B.matrix.decompose(B.position,B.quaternion,B.scale)),He===!0&&B.cameras.push(Ae)}let Ee=r.enabledFeatures;if(Ee&&Ee.includes("depth-sensing")&&r.depthUsage=="gpu-optimized"&&v){f=n.getBinding();let ae=f.getDepthInformation(Ce[0]);ae&&ae.isValid&&ae.texture&&g.init(ae,r.renderState)}if(Ee&&Ee.includes("camera-access")&&v){e.state.unbindTexture(),f=n.getBinding();for(let ae=0;ae<Ce.length;ae++){let xe=Ce[ae].camera;if(xe){let we=m[xe];we||(we=new $o,m[xe]=we);let Ae=f.getCameraImage(xe);we.sourceTexture=Ae}}}}for(let Ce=0;Ce<S.length;Ce++){let He=b[Ce],Ee=S[Ce];He!==null&&Ee!==void 0&&Ee.update(He,oe,c||o)}We&&We($,oe),oe.detectedPlanes&&n.dispatchEvent({type:"planesdetected",data:oe}),p=null}let Ye=new ox;Ye.setAnimationLoop(Fe),this.setAnimationLoop=function($){We=$},this.dispose=function(){}}},f2=new it,dx=new ft;dx.set(-1,0,0,0,1,0,0,0,1);function d2(i,e){function t(g,m){g.matrixAutoUpdate===!0&&g.updateMatrix(),m.value.copy(g.matrix)}function n(g,m){m.color.getRGB(g.fogColor.value,gm(i)),m.isFog?(g.fogNear.value=m.near,g.fogFar.value=m.far):m.isFogExp2&&(g.fogDensity.value=m.density)}function r(g,m,y,_,x){m.isNodeMaterial?m.uniformsNeedUpdate=!1:m.isMeshBasicMaterial?s(g,m):m.isMeshLambertMaterial?(s(g,m),m.envMap&&(g.envMapIntensity.value=m.envMapIntensity)):m.isMeshToonMaterial?(s(g,m),f(g,m)):m.isMeshPhongMaterial?(s(g,m),u(g,m),m.envMap&&(g.envMapIntensity.value=m.envMapIntensity)):m.isMeshStandardMaterial?(s(g,m),h(g,m),m.isMeshPhysicalMaterial&&d(g,m,x)):m.isMeshMatcapMaterial?(s(g,m),p(g,m)):m.isMeshDepthMaterial?s(g,m):m.isMeshDistanceMaterial?(s(g,m),v(g,m)):m.isMeshNormalMaterial?s(g,m):m.isLineBasicMaterial?(o(g,m),m.isLineDashedMaterial&&a(g,m)):m.isPointsMaterial?l(g,m,y,_):m.isSpriteMaterial?c(g,m):m.isShadowMaterial?(g.color.value.copy(m.color),g.opacity.value=m.opacity):m.isShaderMaterial&&(m.uniformsNeedUpdate=!1)}function s(g,m){g.opacity.value=m.opacity,m.color&&g.diffuse.value.copy(m.color),m.emissive&&g.emissive.value.copy(m.emissive).multiplyScalar(m.emissiveIntensity),m.map&&(g.map.value=m.map,t(m.map,g.mapTransform)),m.alphaMap&&(g.alphaMap.value=m.alphaMap,t(m.alphaMap,g.alphaMapTransform)),m.bumpMap&&(g.bumpMap.value=m.bumpMap,t(m.bumpMap,g.bumpMapTransform),g.bumpScale.value=m.bumpScale,m.side===gn&&(g.bumpScale.value*=-1)),m.normalMap&&(g.normalMap.value=m.normalMap,t(m.normalMap,g.normalMapTransform),g.normalScale.value.copy(m.normalScale),m.side===gn&&g.normalScale.value.negate()),m.displacementMap&&(g.displacementMap.value=m.displacementMap,t(m.displacementMap,g.displacementMapTransform),g.displacementScale.value=m.displacementScale,g.displacementBias.value=m.displacementBias),m.emissiveMap&&(g.emissiveMap.value=m.emissiveMap,t(m.emissiveMap,g.emissiveMapTransform)),m.specularMap&&(g.specularMap.value=m.specularMap,t(m.specularMap,g.specularMapTransform)),m.alphaTest>0&&(g.alphaTest.value=m.alphaTest);let y=e.get(m),_=y.envMap,x=y.envMapRotation;_&&(g.envMap.value=_,g.envMapRotation.value.setFromMatrix4(f2.makeRotationFromEuler(x)).transpose(),_.isCubeTexture&&_.isRenderTargetTexture===!1&&g.envMapRotation.value.premultiply(dx),g.reflectivity.value=m.reflectivity,g.ior.value=m.ior,g.refractionRatio.value=m.refractionRatio),m.lightMap&&(g.lightMap.value=m.lightMap,g.lightMapIntensity.value=m.lightMapIntensity,t(m.lightMap,g.lightMapTransform)),m.aoMap&&(g.aoMap.value=m.aoMap,g.aoMapIntensity.value=m.aoMapIntensity,t(m.aoMap,g.aoMapTransform))}function o(g,m){g.diffuse.value.copy(m.color),g.opacity.value=m.opacity,m.map&&(g.map.value=m.map,t(m.map,g.mapTransform))}function a(g,m){g.dashSize.value=m.dashSize,g.totalSize.value=m.dashSize+m.gapSize,g.scale.value=m.scale}function l(g,m,y,_){g.diffuse.value.copy(m.color),g.opacity.value=m.opacity,g.size.value=m.size*y,g.scale.value=_*.5,m.map&&(g.map.value=m.map,t(m.map,g.uvTransform)),m.alphaMap&&(g.alphaMap.value=m.alphaMap,t(m.alphaMap,g.alphaMapTransform)),m.alphaTest>0&&(g.alphaTest.value=m.alphaTest)}function c(g,m){g.diffuse.value.copy(m.color),g.opacity.value=m.opacity,g.rotation.value=m.rotation,m.map&&(g.map.value=m.map,t(m.map,g.mapTransform)),m.alphaMap&&(g.alphaMap.value=m.alphaMap,t(m.alphaMap,g.alphaMapTransform)),m.alphaTest>0&&(g.alphaTest.value=m.alphaTest)}function u(g,m){g.specular.value.copy(m.specular),g.shininess.value=Math.max(m.shininess,1e-4)}function f(g,m){m.gradientMap&&(g.gradientMap.value=m.gradientMap)}function h(g,m){g.metalness.value=m.metalness,m.metalnessMap&&(g.metalnessMap.value=m.metalnessMap,t(m.metalnessMap,g.metalnessMapTransform)),g.roughness.value=m.roughness,m.roughnessMap&&(g.roughnessMap.value=m.roughnessMap,t(m.roughnessMap,g.roughnessMapTransform)),m.envMap&&(g.envMapIntensity.value=m.envMapIntensity)}function d(g,m,y){g.ior.value=m.ior,m.sheen>0&&(g.sheenColor.value.copy(m.sheenColor).multiplyScalar(m.sheen),g.sheenRoughness.value=m.sheenRoughness,m.sheenColorMap&&(g.sheenColorMap.value=m.sheenColorMap,t(m.sheenColorMap,g.sheenColorMapTransform)),m.sheenRoughnessMap&&(g.sheenRoughnessMap.value=m.sheenRoughnessMap,t(m.sheenRoughnessMap,g.sheenRoughnessMapTransform))),m.clearcoat>0&&(g.clearcoat.value=m.clearcoat,g.clearcoatRoughness.value=m.clearcoatRoughness,m.clearcoatMap&&(g.clearcoatMap.value=m.clearcoatMap,t(m.clearcoatMap,g.clearcoatMapTransform)),m.clearcoatRoughnessMap&&(g.clearcoatRoughnessMap.value=m.clearcoatRoughnessMap,t(m.clearcoatRoughnessMap,g.clearcoatRoughnessMapTransform)),m.clearcoatNormalMap&&(g.clearcoatNormalMap.value=m.clearcoatNormalMap,t(m.clearcoatNormalMap,g.clearcoatNormalMapTransform),g.clearcoatNormalScale.value.copy(m.clearcoatNormalScale),m.side===gn&&g.clearcoatNormalScale.value.negate())),m.dispersion>0&&(g.dispersion.value=m.dispersion),m.retroreflectivity>0&&(g.retroreflectivity.value=m.retroreflectivity),m.iridescence>0&&(g.iridescence.value=m.iridescence,g.iridescenceIOR.value=m.iridescenceIOR,g.iridescenceThicknessMinimum.value=m.iridescenceThicknessRange[0],g.iridescenceThicknessMaximum.value=m.iridescenceThicknessRange[1],m.iridescenceMap&&(g.iridescenceMap.value=m.iridescenceMap,t(m.iridescenceMap,g.iridescenceMapTransform)),m.iridescenceThicknessMap&&(g.iridescenceThicknessMap.value=m.iridescenceThicknessMap,t(m.iridescenceThicknessMap,g.iridescenceThicknessMapTransform))),m.transmission>0&&(g.transmission.value=m.transmission,g.transmissionSamplerMap.value=y.texture,g.transmissionSamplerSize.value.set(y.width,y.height),m.transmissionMap&&(g.transmissionMap.value=m.transmissionMap,t(m.transmissionMap,g.transmissionMapTransform)),g.thickness.value=m.thickness,m.thicknessMap&&(g.thicknessMap.value=m.thicknessMap,t(m.thicknessMap,g.thicknessMapTransform)),g.attenuationDistance.value=m.attenuationDistance,g.attenuationColor.value.copy(m.attenuationColor)),m.anisotropy>0&&(g.anisotropyVector.value.set(m.anisotropy*Math.cos(m.anisotropyRotation),m.anisotropy*Math.sin(m.anisotropyRotation)),m.anisotropyMap&&(g.anisotropyMap.value=m.anisotropyMap,t(m.anisotropyMap,g.anisotropyMapTransform))),g.specularIntensity.value=m.specularIntensity,g.specularColor.value.copy(m.specularColor),m.specularColorMap&&(g.specularColorMap.value=m.specularColorMap,t(m.specularColorMap,g.specularColorMapTransform)),m.specularIntensityMap&&(g.specularIntensityMap.value=m.specularIntensityMap,t(m.specularIntensityMap,g.specularIntensityMapTransform))}function p(g,m){m.matcap&&(g.matcap.value=m.matcap)}function v(g,m){let y=e.get(m).light;g.referencePosition.value.setFromMatrixPosition(y.matrixWorld),g.nearDistance.value=y.shadow.camera.near,g.farDistance.value=y.shadow.camera.far}return{refreshFogUniforms:n,refreshMaterialUniforms:r}}function p2(i,e,t,n){let r={},s={},o=[],a=i.getParameter(i.MAX_UNIFORM_BUFFER_BINDINGS);function l(x,S){let b=S.program;n.uniformBlockBinding(x,b)}function c(x,S){let b=r[x.id];b===void 0&&(g(x),b=u(x),r[x.id]=b,x.addEventListener("dispose",y));let E=S.program;n.updateUBOMapping(x,E);let M=e.render.frame;s[x.id]!==M&&(h(x),s[x.id]=M)}function u(x){let S=f();x.__bindingPointIndex=S;let b=i.createBuffer(),E=x.__size,M=x.usage;return i.bindBuffer(i.UNIFORM_BUFFER,b),i.bufferData(i.UNIFORM_BUFFER,E,M),i.bindBuffer(i.UNIFORM_BUFFER,null),i.bindBufferBase(i.UNIFORM_BUFFER,S,b),b}function f(){for(let x=0;x<a;x++)if(o.indexOf(x)===-1)return o.push(x),x;return Qe("WebGLRenderer: Maximum number of simultaneously usable uniforms groups reached."),0}function h(x){let S=r[x.id],b=x.uniforms,E=x.__cache;i.bindBuffer(i.UNIFORM_BUFFER,S);for(let M=0,T=b.length;M<T;M++){let A=b[M];if(Array.isArray(A))for(let I=0,D=A.length;I<D;I++)d(A[I],M,I,E);else d(A,M,0,E)}i.bindBuffer(i.UNIFORM_BUFFER,null)}function d(x,S,b,E){if(v(x,S,b,E)===!0){let M=x.__offset,T=x.value;if(Array.isArray(T)){let A=0;for(let I=0;I<T.length;I++){let D=T[I],B=m(D);p(D,x.__data,A),typeof D!="number"&&typeof D!="boolean"&&!D.isMatrix3&&!ArrayBuffer.isView(D)&&(A+=B.storage/Float32Array.BYTES_PER_ELEMENT)}}else p(T,x.__data,0);i.bufferSubData(i.UNIFORM_BUFFER,M,x.__data)}}function p(x,S,b){typeof x=="number"||typeof x=="boolean"?S[0]=x:x.isMatrix3?(S[0]=x.elements[0],S[1]=x.elements[1],S[2]=x.elements[2],S[3]=0,S[4]=x.elements[3],S[5]=x.elements[4],S[6]=x.elements[5],S[7]=0,S[8]=x.elements[6],S[9]=x.elements[7],S[10]=x.elements[8],S[11]=0):ArrayBuffer.isView(x)?S.set(new x.constructor(x.buffer,x.byteOffset,S.length)):x.toArray(S,b)}function v(x,S,b,E){let M=x.value,T=S+"_"+b;if(E[T]===void 0)return typeof M=="number"||typeof M=="boolean"?E[T]=M:ArrayBuffer.isView(M)?E[T]=M.slice():E[T]=M.clone(),!0;{let A=E[T];if(typeof M=="number"||typeof M=="boolean"){if(A!==M)return E[T]=M,!0}else{if(ArrayBuffer.isView(M))return!0;if(A.equals(M)===!1)return A.copy(M),!0}}return!1}function g(x){let S=x.uniforms,b=0,E=16;for(let T=0,A=S.length;T<A;T++){let I=Array.isArray(S[T])?S[T]:[S[T]];for(let D=0,B=I.length;D<B;D++){let F=I[D],L=Array.isArray(F.value)?F.value:[F.value];for(let U=0,X=L.length;U<X;U++){let te=L[U],Z=m(te),K=b%E,j=K%Z.boundary,ne=K+j;b+=j,ne!==0&&E-ne<Z.storage&&(b+=E-ne),F.__data=new Float32Array(Z.storage/Float32Array.BYTES_PER_ELEMENT),F.__offset=b,b+=Z.storage}}}let M=b%E;return M>0&&(b+=E-M),x.__size=b,x.__cache={},this}function m(x){let S={boundary:0,storage:0};return typeof x=="number"||typeof x=="boolean"?(S.boundary=4,S.storage=4):x.isVector2?(S.boundary=8,S.storage=8):x.isVector3||x.isColor?(S.boundary=16,S.storage=12):x.isVector4?(S.boundary=16,S.storage=16):x.isMatrix3?(S.boundary=48,S.storage=48):x.isMatrix4?(S.boundary=64,S.storage=64):x.isTexture?Ge("WebGLRenderer: Texture samplers can not be part of an uniforms group."):ArrayBuffer.isView(x)?(S.boundary=16,S.storage=x.byteLength):Ge("WebGLRenderer: Unsupported uniform value type.",x),S}function y(x){let S=x.target;S.removeEventListener("dispose",y);let b=o.indexOf(S.__bindingPointIndex);o.splice(b,1),i.deleteBuffer(r[S.id]),delete r[S.id],delete s[S.id]}function _(){for(let x in r)i.deleteBuffer(r[x]);o=[],r={},s={}}return{bind:l,update:c,dispose:_}}var m2=new Uint16Array([12469,15057,12620,14925,13266,14620,13807,14376,14323,13990,14545,13625,14713,13328,14840,12882,14931,12528,14996,12233,15039,11829,15066,11525,15080,11295,15085,10976,15082,10705,15073,10495,13880,14564,13898,14542,13977,14430,14158,14124,14393,13732,14556,13410,14702,12996,14814,12596,14891,12291,14937,11834,14957,11489,14958,11194,14943,10803,14921,10506,14893,10278,14858,9960,14484,14039,14487,14025,14499,13941,14524,13740,14574,13468,14654,13106,14743,12678,14818,12344,14867,11893,14889,11509,14893,11180,14881,10751,14852,10428,14812,10128,14765,9754,14712,9466,14764,13480,14764,13475,14766,13440,14766,13347,14769,13070,14786,12713,14816,12387,14844,11957,14860,11549,14868,11215,14855,10751,14825,10403,14782,10044,14729,9651,14666,9352,14599,9029,14967,12835,14966,12831,14963,12804,14954,12723,14936,12564,14917,12347,14900,11958,14886,11569,14878,11247,14859,10765,14828,10401,14784,10011,14727,9600,14660,9289,14586,8893,14508,8533,15111,12234,15110,12234,15104,12216,15092,12156,15067,12010,15028,11776,14981,11500,14942,11205,14902,10752,14861,10393,14812,9991,14752,9570,14682,9252,14603,8808,14519,8445,14431,8145,15209,11449,15208,11451,15202,11451,15190,11438,15163,11384,15117,11274,15055,10979,14994,10648,14932,10343,14871,9936,14803,9532,14729,9218,14645,8742,14556,8381,14461,8020,14365,7603,15273,10603,15272,10607,15267,10619,15256,10631,15231,10614,15182,10535,15118,10389,15042,10167,14963,9787,14883,9447,14800,9115,14710,8665,14615,8318,14514,7911,14411,7507,14279,7198,15314,9675,15313,9683,15309,9712,15298,9759,15277,9797,15229,9773,15166,9668,15084,9487,14995,9274,14898,8910,14800,8539,14697,8234,14590,7790,14479,7409,14367,7067,14178,6621,15337,8619,15337,8631,15333,8677,15325,8769,15305,8871,15264,8940,15202,8909,15119,8775,15022,8565,14916,8328,14804,8009,14688,7614,14569,7287,14448,6888,14321,6483,14088,6171,15350,7402,15350,7419,15347,7480,15340,7613,15322,7804,15287,7973,15229,8057,15148,8012,15046,7846,14933,7611,14810,7357,14682,7069,14552,6656,14421,6316,14251,5948,14007,5528,15356,5942,15356,5977,15353,6119,15348,6294,15332,6551,15302,6824,15249,7044,15171,7122,15070,7050,14949,6861,14818,6611,14679,6349,14538,6067,14398,5651,14189,5311,13935,4958,15359,4123,15359,4153,15356,4296,15353,4646,15338,5160,15311,5508,15263,5829,15188,6042,15088,6094,14966,6001,14826,5796,14678,5543,14527,5287,14377,4985,14133,4586,13869,4257,15360,1563,15360,1642,15358,2076,15354,2636,15341,3350,15317,4019,15273,4429,15203,4732,15105,4911,14981,4932,14836,4818,14679,4621,14517,4386,14359,4156,14083,3795,13808,3437,15360,122,15360,137,15358,285,15355,636,15344,1274,15322,2177,15281,2765,15215,3223,15120,3451,14995,3569,14846,3567,14681,3466,14511,3305,14344,3121,14037,2800,13753,2467,15360,0,15360,1,15359,21,15355,89,15346,253,15325,479,15287,796,15225,1148,15133,1492,15008,1749,14856,1882,14685,1886,14506,1783,14324,1608,13996,1398,13702,1183]),sr=null;function g2(){return sr===null&&(sr=new Gn(m2,16,16,Ir,ln),sr.name="DFG_LUT",sr.minFilter=zt,sr.magFilter=zt,sr.wrapS=zn,sr.wrapT=zn,sr.generateMipmaps=!1,sr.needsUpdate=!0),sr}var Lr=class{constructor(e={}){let{canvas:t=dm(),context:n=null,depth:r=!0,stencil:s=!1,alpha:o=!1,antialias:a=!1,premultipliedAlpha:l=!0,preserveDrawingBuffer:c=!1,powerPreference:u="default",failIfMajorPerformanceCaveat:f=!1,reversedDepthBuffer:h=!1,outputBufferType:d=Xn}=e;this.isWebGLRenderer=!0;let p;if(n!==null){if(typeof WebGLRenderingContext<"u"&&n instanceof WebGLRenderingContext)throw new Error("THREE.WebGLRenderer: WebGL 1 is not supported since r163.");p=n.getContextAttributes().alpha}else p=o;let v=d,g=new Set([Cc,Ec,Sa]),m=new Set([Xn,hi,Js,Ks,wc,Tc]),y=new Uint32Array(4),_=new Int32Array(4),x=new R,S=null,b=null,E=[],M=[],T=null;this.domElement=t,this.debug={checkShaderErrors:!0,diagnostics:{keywords:!1},onShaderError:null},this.autoClear=!0,this.autoClearColor=!0,this.autoClearDepth=!0,this.autoClearStencil=!0,this.sortObjects=!0,this.clippingPlanes=[],this.localClippingEnabled=!1,this.toneMapping=Mn,this.toneMappingExposure=1,this.transmissionResolutionScale=1;let A=this,I=!1,D=null,B=null,F=null,L=null;this._outputColorSpace=nn;let U=0,X=0,te=null,Z=-1,K=null,j=new Pt,ne=new Pt,ie=null,We=new be(0),Fe=0,Ye=t.width,$=t.height,oe=1,Ce=null,He=null,Ee=new Pt(0,0,Ye,$),ze=new Pt(0,0,Ye,$),pt=!1,ae=new Ki,xe=!1,we=!1,Ae=new it,Te=new R,de=new Pt,Oe={background:null,fog:null,environment:null,overrideMaterial:null,isScene:!0},Re=!1;function Je(){return te===null?oe:1}let z=n;function lt(C,H){return t.getContext(C,H)}let rt,P,w,q,J,G,re,Q,V,ee,le,Se,me,_e,ce,fe,De,O,Me,se,Pe,Be,ue;try{let C={alpha:!0,depth:r,stencil:s,antialias:a,premultipliedAlpha:l,preserveDrawingBuffer:c,powerPreference:u,failIfMajorPerformanceCaveat:f};if("setAttribute"in t&&t.setAttribute("data-engine",`three.js r${"186"}`),t.addEventListener("webglcontextlost",Mt,!1),t.addEventListener("webglcontextrestored",ct,!1),t.addEventListener("webglcontextcreationerror",Vt,!1),z===null){let H="webgl2";if(z=lt(H,C),z===null)throw lt(H)?new Error("THREE.WebGLRenderer: Error creating WebGL context with your selected attributes."):new Error("THREE.WebGLRenderer: Error creating WebGL context.")}je()}catch(C){throw t.removeEventListener("webglcontextlost",Mt,!1),t.removeEventListener("webglcontextrestored",ct,!1),t.removeEventListener("webglcontextcreationerror",Vt,!1),Qe("WebGLRenderer: "+C.message),C}function je(){rt=new wb(z),rt.init(),Pe=new fx(z,rt),P=new pb(z,rt,e,Pe),w=new l2(z,rt),P.reversedDepthBuffer&&h&&w.buffers.depth.setReversed(!0),B=z.createFramebuffer(),F=z.createFramebuffer(),L=z.createFramebuffer(),q=new Eb(z),J=new Zw,G=new c2(z,rt,w,J,P,Pe,q),re=new bb(A),Q=new R1(z),Be=new fb(z,Q),V=new Tb(z,Q,q,Be),ee=new Rb(z,V,Q,Be,q),O=new Cb(z,P,G),ce=new mb(J),le=new Yw(A,re,rt,P,Be,ce),Se=new d2(A,J),me=new Jw,_e=new n2(rt),De=new hb(A,re,w,ee,p,l),fe=new a2(A,ee,P),ue=new p2(z,q,P,w),Me=new db(z,rt,q),se=new Ab(z,rt,q),q.programs=le.programs,A.capabilities=P,A.extensions=rt,A.properties=J,A.renderLists=me,A.shadowMap=fe,A.state=w,A.info=q}v!==Xn&&(T=new Ib(v,t.width,t.height,a,r,s));let Ze=new zm(A,z);this.xr=Ze,this.getContext=function(){return z},this.getContextAttributes=function(){return z.getContextAttributes()},this.forceContextLoss=function(){let C=rt.get("WEBGL_lose_context");C&&C.loseContext()},this.forceContextRestore=function(){let C=rt.get("WEBGL_lose_context");C&&C.restoreContext()},this.getPixelRatio=function(){return oe},this.setPixelRatio=function(C){C!==void 0&&(oe=C,this.setSize(Ye,$,!1))},this.getSize=function(C){return C.set(Ye,$)},this.setSize=function(C,H,N=!0){if(Ze.isPresenting){Ge("WebGLRenderer: Can't change size while VR device is presenting.");return}Ye=C,$=H,t.width=Math.floor(C*oe),t.height=Math.floor(H*oe),N===!0&&(t.style.width=C+"px",t.style.height=H+"px"),T!==null&&T.setSize(t.width,t.height),this.setViewport(0,0,C,H)},this.getDrawingBufferSize=function(C){return C.set(Ye*oe,$*oe).floor()},this.setDrawingBufferSize=function(C,H,N){Ye=C,$=H,oe=N,t.width=Math.floor(C*N),t.height=Math.floor(H*N),this.setViewport(0,0,C,H)},this.setEffects=function(C){if(v===Xn){Qe("WebGLRenderer: setEffects() requires outputBufferType set to HalfFloatType or FloatType.");return}if(C){for(let H=0;H<C.length;H++)if(C[H].isOutputPass===!0){Ge("WebGLRenderer: OutputPass is not needed in setEffects(). Tone mapping and color space conversion are applied automatically.");break}}T.setEffects(C||[])},this.getCurrentViewport=function(C){return C.copy(j)},this.getViewport=function(C){return C.copy(Ee)},this.setViewport=function(C,H,N,k){C.isVector4?Ee.set(C.x,C.y,C.z,C.w):Ee.set(C,H,N,k),w.viewport(j.copy(Ee).multiplyScalar(oe).round())},this.getScissor=function(C){return C.copy(ze)},this.setScissor=function(C,H,N,k){C.isVector4?ze.set(C.x,C.y,C.z,C.w):ze.set(C,H,N,k),w.scissor(ne.copy(ze).multiplyScalar(oe).round())},this.getScissorTest=function(){return pt},this.setScissorTest=function(C){w.setScissorTest(pt=C)},this.setOpaqueSort=function(C){Ce=C},this.setTransparentSort=function(C){He=C},this.getClearColor=function(C){return C.copy(De.getClearColor())},this.setClearColor=function(){De.setClearColor(...arguments)},this.getClearAlpha=function(){return De.getClearAlpha()},this.setClearAlpha=function(){De.setClearAlpha(...arguments)},this.clear=function(C=!0,H=!0,N=!0){let k=0;if(C){let W=!1;if(te!==null){let ye=te.texture.format;W=g.has(ye)}if(W){let ye=te.texture.type,Ie=m.has(ye),Ue=De.getClearColor(),Ne=De.getClearAlpha(),Y=Ue.r,ve=Ue.g,Le=Ue.b;Ie?(y[0]=Y,y[1]=ve,y[2]=Le,y[3]=Ne,z.clearBufferuiv(z.COLOR,0,y)):(_[0]=Y,_[1]=ve,_[2]=Le,_[3]=Ne,z.clearBufferiv(z.COLOR,0,_))}else k|=z.COLOR_BUFFER_BIT}H&&(k|=z.DEPTH_BUFFER_BIT,this.state.buffers.depth.setMask(!0)),N&&(k|=z.STENCIL_BUFFER_BIT,this.state.buffers.stencil.setMask(4294967295)),k!==0&&z.clear(k)},this.clearColor=function(){this.clear(!0,!1,!1)},this.clearDepth=function(){this.clear(!1,!0,!1)},this.clearStencil=function(){this.clear(!1,!1,!0)},this.setNodesHandler=function(C){C.setRenderer(this),D=C},this.dispose=function(){t.removeEventListener("webglcontextlost",Mt,!1),t.removeEventListener("webglcontextrestored",ct,!1),t.removeEventListener("webglcontextcreationerror",Vt,!1),De.dispose(),me.dispose(),_e.dispose(),J.dispose(),re.dispose(),ee.dispose(),Be.dispose(),ue.dispose(),le.dispose(),Ze.dispose(),Ze.removeEventListener("sessionstart",vi),Ze.removeEventListener("sessionend",cr),Yn.stop()};function Mt(C){C.preventDefault(),Go("WebGLRenderer: Context Lost."),I=!0}function ct(){Go("WebGLRenderer: Context Restored."),I=!1;let C=q.autoReset,H=fe.enabled,N=fe.autoUpdate,k=fe.needsUpdate,W=fe.type;je(),q.autoReset=C,fe.enabled=H,fe.autoUpdate=N,fe.needsUpdate=k,fe.type=W}function Vt(C){Qe("WebGLRenderer: A WebGL context could not be created. Reason: ",C.statusMessage)}function kt(C){let H=C.target;H.removeEventListener("dispose",kt),ni(H)}function ni(C){ii(C),J.remove(C)}function ii(C){let H=J.get(C).programs;H!==void 0&&(H.forEach(function(N){le.releaseProgram(N)}),C.isShaderMaterial&&le.releaseShaderCache(C))}this.renderBufferDirect=function(C,H,N,k,W,ye){H===null&&(H=Oe);let Ie=W.isMesh&&W.matrixWorld.determinantAffine()<0,Ue=Bt(C,H,N,k,W);w.setMaterial(k,Ie);let Ne=N.index,Y=1;if(k.wireframe===!0){if(Ne=V.getWireframeAttribute(N),Ne===void 0)return;Y=2}let ve=N.drawRange,Le=N.attributes.position,ge=ve.start*Y,qe=(ve.start+ve.count)*Y;ye!==null&&(ge=Math.max(ge,ye.start*Y),qe=Math.min(qe,(ye.start+ye.count)*Y)),Ne!==null?(ge=Math.max(ge,0),qe=Math.min(qe,Ne.count)):Le!=null&&(ge=Math.max(ge,0),qe=Math.min(qe,Le.count));let $e=qe-ge;if($e<0||$e===1/0)return;Be.setup(W,k,Ue,N,Ne);let tt,st=Me;if(Ne!==null&&(tt=Q.get(Ne),st=se,st.setIndex(tt)),W.isMesh)k.wireframe===!0?(w.setLineWidth(k.wireframeLinewidth*Je()),st.setMode(z.LINES)):st.setMode(z.TRIANGLES);else if(W.isLine){let It=k.linewidth;It===void 0&&(It=1),w.setLineWidth(It*Je()),W.isLineSegments?st.setMode(z.LINES):W.isLineLoop?st.setMode(z.LINE_LOOP):st.setMode(z.LINE_STRIP)}else W.isPoints?st.setMode(z.POINTS):W.isSprite&&st.setMode(z.TRIANGLES);if(W.isBatchedMesh)if(rt.get("WEBGL_multi_draw"))st.renderMultiDraw(W._multiDrawStarts,W._multiDrawCounts,W._multiDrawCount);else{let It=W._multiDrawStarts,ke=W._multiDrawCounts,wt=W._multiDrawCount,ut=Ne?Q.get(Ne).bytesPerElement:1,Tt=J.get(k).currentProgram.getUniforms();for(let Ot=0;Ot<wt;Ot++)Tt.setValue(z,"_gl_DrawID",Ot),st.render(It[Ot]/ut,ke[Ot])}else if(W.isInstancedMesh)st.renderInstances(ge,$e,W.count);else if(N.isInstancedBufferGeometry){let It=N._maxInstanceCount!==void 0?N._maxInstanceCount:1/0,ke=Math.min(N.instanceCount,It);st.renderInstances(ge,$e,ke)}else st.render(ge,$e)};function Hi(C,H,N,k){D!==null&&C.isNodeMaterial&&D.setObject(k,C),xe===!0&&ce.setState(C,N,!1),C.transparent===!0&&C.side===vn&&C.forceSinglePass===!1?(C.side=gn,C.needsUpdate=!0,yi(C,H,k),C.side=Er,C.needsUpdate=!0,yi(C,H,k),C.side=vn):yi(C,H,k)}this.compile=function(C,H,N=null){N===null&&(N=C),D!==null&&D.renderStart(C,H,N),b=_e.get(N),b.init(H),M.push(b),N.traverseVisible(function(W){W.isLight&&W.layers.test(H.layers)&&(b.pushLight(W),W.castShadow&&b.pushShadow(W))}),C!==N&&C.traverseVisible(function(W){W.isLight&&W.layers.test(H.layers)&&(b.pushLight(W),W.castShadow&&b.pushShadow(W))}),b.setupLights(),D!==null&&D.updateLights(b.state.lightsArray),we=this.localClippingEnabled,xe=ce.init(this.clippingPlanes,we),xe===!0&&ce.setGlobalState(this.clippingPlanes,H),D!==null&&fe.render(b.state.shadowsArray,N,H);let k=new Set;return C.traverse(function(W){if(!(W.isMesh||W.isPoints||W.isLine||W.isSprite))return;let ye=W.material;if(ye)if(Array.isArray(ye))for(let Ie=0;Ie<ye.length;Ie++){let Ue=ye[Ie];Hi(Ue,N,H,W),k.add(Ue)}else Hi(ye,N,H,W),k.add(ye)}),b=M.pop(),D!==null&&D.renderEnd(),k},this.compileAsync=function(C,H,N=null){let k=this.compile(C,H,N);return new Promise(W=>{function ye(){if(k.forEach(function(Ie){let Ne=J.get(Ie).currentProgram;(Ne===void 0||Ne.isReady())&&k.delete(Ie)}),k.size===0){W(C);return}setTimeout(ye,10)}rt.get("KHR_parallel_shader_compile")!==null?ye():setTimeout(ye,10)})};let Wi=null;function ri(C){Wi&&Wi(C)}function vi(){Yn.stop()}function cr(){Yn.start()}let Yn=new ox;Yn.setAnimationLoop(ri),typeof self<"u"&&Yn.setContext(self),this.setAnimationLoop=function(C){Wi=C,Ze.setAnimationLoop(C),C===null?Yn.stop():Yn.start()},Ze.addEventListener("sessionstart",vi),Ze.addEventListener("sessionend",cr),this.render=function(C,H){if(H!==void 0&&H.isCamera!==!0){Qe("WebGLRenderer.render: camera is not an instance of THREE.Camera.");return}if(I===!0)return;D!==null&&D.renderStart(C,H);let N=Ze.enabled===!0&&Ze.isPresenting===!0,k=T!==null&&(te===null||N)&&T.begin(A,te);if(C.matrixWorldAutoUpdate===!0&&C.updateMatrixWorld(),H.parent===null&&H.matrixWorldAutoUpdate===!0&&H.updateMatrixWorld(),Ze.enabled===!0&&Ze.isPresenting===!0&&(T===null||T.isCompositing()===!1)&&(Ze.cameraAutoUpdate===!0&&Ze.updateCamera(H),H=Ze.getCamera()),C.isScene===!0&&C.onBeforeRender(A,C,H,te),b=_e.get(C,M.length),b.init(H),b.state.textureUnits=G.getTextureUnits(),M.push(b),Ae.multiplyMatrices(H.projectionMatrix,H.matrixWorldInverse),ae.setFromProjectionMatrix(Ae,Kn,H.reversedDepth),we=this.localClippingEnabled,xe=ce.init(this.clippingPlanes,we),S=me.get(C,E.length),S.init(),E.push(S),Ze.enabled===!0&&Ze.isPresenting===!0){let Ie=A.xr.getDepthSensingMesh();Ie!==null&&Ci(Ie,H,-1/0,A.sortObjects)}Ci(C,H,0,A.sortObjects),S.finish(),D!==null&&D.updateLights(b.state.lightsArray),A.sortObjects===!0&&S.sort(Ce,He),Re=Ze.enabled===!1||Ze.isPresenting===!1||Ze.hasDepthSensing()===!1,Re&&De.addToRenderList(S,C),this.info.render.frame++,this.info.autoReset===!0&&this.info.reset(),xe===!0&&ce.beginShadows();let W=b.state.shadowsArray;if(fe.render(W,C,H),xe===!0&&ce.endShadows(),(k&&T.hasRenderPass())===!1){let Ie=S.opaque,Ue=S.transmissive;if(b.setupLights(),H.isArrayCamera){let Ne=H.cameras;if(Ue.length>0)for(let Y=0,ve=Ne.length;Y<ve;Y++){let Le=Ne[Y];Xi(Ie,Ue,C,Le)}Re&&De.render(C);for(let Y=0,ve=Ne.length;Y<ve;Y++){let Le=Ne[Y];xi(S,C,Le,Le.viewport)}}else Ue.length>0&&Xi(Ie,Ue,C,H),Re&&De.render(C),xi(S,C,H)}te!==null&&X===0&&(G.updateMultisampleRenderTarget(te),G.updateRenderTargetMipmap(te)),k&&T.end(A),C.isScene===!0&&C.onAfterRender(A,C,H),Be.resetDefaultState(),Z=-1,K=null,M.pop(),M.length>0?(b=M[M.length-1],G.setTextureUnits(b.state.textureUnits),xe===!0&&ce.setGlobalState(A.clippingPlanes,b.state.camera)):b=null,E.pop(),E.length>0?S=E[E.length-1]:S=null,D!==null&&D.renderEnd()};function Ci(C,H,N,k){if(C.visible===!1)return;if(C.layers.test(H.layers)){if(C.isGroup)N=C.renderOrder;else if(C.isLOD)C.autoUpdate===!0&&C.update(H);else if(C.isLightProbeGrid)b.pushLightProbeGrid(C);else if(C.isLight)b.pushLight(C),C.castShadow&&b.pushShadow(C);else if(C.isSprite){if(!C.frustumCulled||C.intersectsFrustum(ae)){k&&de.setFromMatrixPosition(C.matrixWorld).applyMatrix4(Ae);let Ie=ee.update(C),Ue=C.material;Ue.visible&&S.push(C,Ie,Ue,N,de.z,null,H)}}else if((C.isMesh||C.isLine||C.isPoints)&&(!C.frustumCulled||C.intersectsFrustum(ae))){let Ie=ee.update(C),Ue=C.material;if(k&&(C.boundingSphere!==void 0?(C.boundingSphere===null&&C.computeBoundingSphere(),de.copy(C.boundingSphere.center)):(Ie.boundingSphere===null&&Ie.computeBoundingSphere(),de.copy(Ie.boundingSphere.center)),de.applyMatrix4(C.matrixWorld).applyMatrix4(Ae)),Array.isArray(Ue)){let Ne=Ie.groups;for(let Y=0,ve=Ne.length;Y<ve;Y++){let Le=Ne[Y],ge=Ue[Le.materialIndex];ge&&ge.visible&&S.push(C,Ie,ge,N,de.z,Le,H)}}else Ue.visible&&S.push(C,Ie,Ue,N,de.z,null,H)}}let ye=C.children;for(let Ie=0,Ue=ye.length;Ie<Ue;Ie++)Ci(ye[Ie],H,N,k)}function xi(C,H,N,k){let{opaque:W,transmissive:ye,transparent:Ie}=C;b.setupLightsView(N),xe===!0&&ce.setGlobalState(A.clippingPlanes,N),k&&w.viewport(j.copy(k)),W.length>0&&Zn(W,H,N),ye.length>0&&Zn(ye,H,N),Ie.length>0&&Zn(Ie,H,N),w.buffers.depth.setTest(!0),w.buffers.depth.setMask(!0),w.buffers.color.setMask(!0),w.setPolygonOffset(!1)}function Xi(C,H,N,k){if((N.isScene===!0?N.overrideMaterial:null)!==null)return;if(b.state.transmissionRenderTarget[k.id]===void 0){let ge=rt.has("EXT_color_buffer_half_float")||rt.has("EXT_color_buffer_float");b.state.transmissionRenderTarget[k.id]=new Gt(1,1,{generateMipmaps:!0,type:ge?ln:Xn,minFilter:ki,samples:Math.max(4,P.samples),stencilBuffer:s,resolveDepthBuffer:!1,resolveStencilBuffer:!1,storeMultisampledDepthBuffer:!1,storeMultisampledStencilBuffer:!1,colorSpace:vt.workingColorSpace})}let ye=b.state.transmissionRenderTarget[k.id],Ie=k.viewport||j;ye.setSize(Ie.z*A.transmissionResolutionScale,Ie.w*A.transmissionResolutionScale);let Ue=A.getRenderTarget(),Ne=A.getActiveCubeFace(),Y=A.getActiveMipmapLevel();A.setRenderTarget(ye),A.getClearColor(We),Fe=A.getClearAlpha(),Fe<1&&A.setClearColor(16777215,.5),A.clear(),Re&&De.render(N);let ve=A.toneMapping;A.toneMapping=Mn;let Le=k.viewport;if(k.viewport!==void 0&&(k.viewport=void 0),b.setupLightsView(k),xe===!0&&ce.setGlobalState(A.clippingPlanes,k),Zn(C,N,k),G.updateMultisampleRenderTarget(ye),G.updateRenderTargetMipmap(ye),rt.has("WEBGL_multisampled_render_to_texture")===!1){let ge=!1;for(let qe=0,$e=H.length;qe<$e;qe++){let tt=H[qe],{object:st,geometry:It,material:ke,group:wt}=tt;if(ke.side===vn&&st.layers.test(k.layers)){let ut=ke.side;ke.side=gn,ke.needsUpdate=!0,qi(st,N,k,It,ke,wt),ke.side=ut,ke.needsUpdate=!0,ge=!0}}ge===!0&&(G.updateMultisampleRenderTarget(ye),G.updateRenderTargetMipmap(ye))}A.setRenderTarget(Ue,Ne,Y),A.setClearColor(We,Fe),Le!==void 0&&(k.viewport=Le),A.toneMapping=ve}function Zn(C,H,N){let k=H.isScene===!0?H.overrideMaterial:null;for(let W=0,ye=C.length;W<ye;W++){let Ie=C[W],{object:Ue,geometry:Ne,group:Y}=Ie,ve=Ie.material;ve.allowOverride===!0&&k!==null&&(ve=k),Ue.layers.test(N.layers)&&qi(Ue,H,N,Ne,ve,Y)}}function qi(C,H,N,k,W,ye){D!==null&&W.isNodeMaterial&&D.setObject(C,W),C.onBeforeRender(A,H,N,k,W,ye),C.modelViewMatrix.multiplyMatrices(N.matrixWorldInverse,C.matrixWorld),C.normalMatrix.getNormalMatrix(C.modelViewMatrix),W.onBeforeRender(A,H,N,k,C,ye),W.transparent===!0&&W.side===vn&&W.forceSinglePass===!1?(W.side=gn,W.needsUpdate=!0,A.renderBufferDirect(N,H,k,W,C,ye),W.side=Er,W.needsUpdate=!0,A.renderBufferDirect(N,H,k,W,C,ye),W.side=vn):A.renderBufferDirect(N,H,k,W,C,ye),C.onAfterRender(A,H,N,k,W,ye)}function yi(C,H,N){H.isScene!==!0&&(H=Oe);let k=J.get(C),W=b.state.lights,ye=b.state.shadowsArray,Ie=W.state.version,Ue=le.getParameters(C,W.state,ye,H,N,b.state.lightProbeGridArray),Ne=le.getProgramCacheKey(Ue),Y=k.programs;k.environment=C.isMeshStandardMaterial||C.isMeshLambertMaterial||C.isMeshPhongMaterial?H.environment:null,k.fog=H.fog;let ve=C.isMeshStandardMaterial||C.isMeshLambertMaterial&&!C.envMap||C.isMeshPhongMaterial&&!C.envMap;k.envMap=re.get(C.envMap||k.environment,ve),k.envMapRotation=k.environment!==null&&C.envMap===null?H.environmentRotation:C.envMapRotation,Y===void 0&&(C.addEventListener("dispose",kt),Y=new Map,k.programs=Y);let Le=Y.get(Ne);if(Le!==void 0){if(k.currentProgram===Le&&k.lightsStateVersion===Ie)return ur(C,Ue),Le}else Ue.uniforms=le.getUniforms(C),D!==null&&C.isNodeMaterial&&D.build(C,N,Ue),C.onBeforeCompile(Ue,A),Le=le.acquireProgram(Ue,Ne),Y.set(Ne,Le),k.uniforms=Ue.uniforms;let ge=k.uniforms;return(!C.isShaderMaterial&&!C.isRawShaderMaterial||C.clipping===!0)&&(ge.clippingPlanes=ce.uniform),ur(C,Ue),k.needsLights=us(C),k.lightsStateVersion=Ie,k.needsLights&&(ge.ambientLightColor.value=W.state.ambient,ge.lightProbe.value=W.state.probe,ge.sunLights.value=W.state.sun,ge.sunLightShadows.value=W.state.sunShadow,ge.directionalLights.value=W.state.directional,ge.directionalLightShadows.value=W.state.directionalShadow,ge.spotLights.value=W.state.spot,ge.spotLightShadows.value=W.state.spotShadow,ge.rectAreaLights.value=W.state.rectArea,ge.ltc_1.value=W.state.rectAreaLTC1,ge.ltc_2.value=W.state.rectAreaLTC2,ge.pointLights.value=W.state.point,ge.pointLightShadows.value=W.state.pointShadow,ge.hemisphereLights.value=W.state.hemi,ge.sunShadowMatrix.value=W.state.sunShadowMatrix,ge.sunShadowCascade.value=W.state.sunShadowCascade,ge.directionalShadowMatrix.value=W.state.directionalShadowMatrix,ge.spotLightMatrix.value=W.state.spotLightMatrix,ge.spotLightMap.value=W.state.spotLightMap,ge.pointShadowMatrix.value=W.state.pointShadowMatrix),k.lightProbeGrid=b.state.lightProbeGridArray.length>0,k.currentProgram=Le,k.uniformsList=null,Le}function Ri(C){if(C.uniformsList===null){let H=C.currentProgram.getUniforms();C.uniformsList=Ia.seqWithValue(H.seq,C.uniforms)}return C.uniformsList}function ur(C,H){let N=J.get(C);N.outputColorSpace=H.outputColorSpace,N.batching=H.batching,N.batchingColor=H.batchingColor,N.instancing=H.instancing,N.instancingColor=H.instancingColor,N.instancingMorph=H.instancingMorph,N.skinning=H.skinning,N.morphTargets=H.morphTargets,N.morphNormals=H.morphNormals,N.morphColors=H.morphColors,N.morphTargetsCount=H.morphTargetsCount,N.numClippingPlanes=H.numClippingPlanes,N.numIntersection=H.numClipIntersection,N.vertexAlphas=H.vertexAlphas,N.vertexTangents=H.vertexTangents,N.toneMapping=H.toneMapping}function Yi(C,H){if(C.length===0)return null;if(C.length===1)return C[0].texture!==null?C[0]:null;x.setFromMatrixPosition(H.matrixWorld);for(let N=0,k=C.length;N<k;N++){let W=C[N];if(W.texture!==null&&W.boundingBox.containsPoint(x))return W}return null}function Bt(C,H,N,k,W){H.isScene!==!0&&(H=Oe),G.resetTextureUnits();let ye=H.fog,Ie=k.isMeshStandardMaterial||k.isMeshLambertMaterial||k.isMeshPhongMaterial?H.environment:null,Ue=te===null?A.outputColorSpace:te.isXRRenderTarget===!0?te.texture.colorSpace:vt.workingColorSpace,Ne=k.isMeshStandardMaterial||k.isMeshLambertMaterial&&!k.envMap||k.isMeshPhongMaterial&&!k.envMap,Y=re.get(k.envMap||Ie,Ne),ve=k.vertexColors===!0&&!!N.attributes.color&&N.attributes.color.itemSize===4,Le=!!N.attributes.tangent&&(!!k.normalMap||k.anisotropy>0),ge=!!N.morphAttributes.position,qe=!!N.morphAttributes.normal,$e=!!N.morphAttributes.color,tt=Mn;k.toneMapped&&(te===null||te.isXRRenderTarget===!0)&&(tt=A.toneMapping);let st=N.morphAttributes.position||N.morphAttributes.normal||N.morphAttributes.color,It=st!==void 0?st.length:0,ke=J.get(k),wt=b.state.lights;if(xe===!0&&(we===!0||C!==K)){let nt=C===K&&k.id===Z;ce.setState(k,C,nt)}let ut=!1;k.version===ke.__version?(ke.needsLights&&ke.lightsStateVersion!==wt.state.version||ke.outputColorSpace!==Ue||W.isBatchedMesh&&ke.batching===!1||!W.isBatchedMesh&&ke.batching===!0||W.isBatchedMesh&&ke.batchingColor===!0&&W._colorsTexture===null||W.isBatchedMesh&&ke.batchingColor===!1&&W._colorsTexture!==null||W.isInstancedMesh&&ke.instancing===!1||!W.isInstancedMesh&&ke.instancing===!0||W.isSkinnedMesh&&ke.skinning===!1||!W.isSkinnedMesh&&ke.skinning===!0||W.isInstancedMesh&&ke.instancingColor===!0&&W.instanceColor===null||W.isInstancedMesh&&ke.instancingColor===!1&&W.instanceColor!==null||W.isInstancedMesh&&ke.instancingMorph===!0&&W.morphTexture===null||W.isInstancedMesh&&ke.instancingMorph===!1&&W.morphTexture!==null||ke.envMap!==Y||k.fog===!0&&ke.fog!==ye||ke.numClippingPlanes!==void 0&&(ke.numClippingPlanes!==ce.numPlanes||ke.numIntersection!==ce.numIntersection)||ke.vertexAlphas!==ve||ke.vertexTangents!==Le||ke.morphTargets!==ge||ke.morphNormals!==qe||ke.morphColors!==$e||ke.toneMapping!==tt||ke.morphTargetsCount!==It||!!ke.lightProbeGrid!=b.state.lightProbeGridArray.length>0)&&(ut=!0):(ut=!0,ke.__version=k.version);let Tt=ke.currentProgram;ut===!0&&(Tt=yi(k,H,W),D&&k.isNodeMaterial&&D.onUpdateProgram(k,Tt,ke));let Ot=!1,rn=!1,Un=!1,xt=Tt.getUniforms(),St=ke.uniforms;if(w.useProgram(Tt.program)&&(Ot=!0,rn=!0,Un=!0),k.id!==Z&&(Z=k.id,rn=!0),ke.needsLights){let nt=Yi(b.state.lightProbeGridArray,W);ke.lightProbeGrid!==nt&&(ke.lightProbeGrid=nt,rn=!0)}if(Ot||K!==C){w.buffers.depth.getReversed()&&C.reversedDepth!==!0&&(C._reversedDepth=!0,C.updateProjectionMatrix()),xt.setValue(z,"projectionMatrix",C.projectionMatrix),xt.setValue(z,"viewMatrix",C.matrixWorldInverse);let Xt=xt.map.cameraPosition;Xt!==void 0&&Xt.setValue(z,Te.setFromMatrixPosition(C.matrixWorld)),P.logarithmicDepthBuffer&&xt.setValue(z,"logDepthBufFC",2/(Math.log(C.far+1)/Math.LN2)),(k.isMeshPhongMaterial||k.isMeshToonMaterial||k.isMeshLambertMaterial||k.isMeshBasicMaterial||k.isMeshStandardMaterial||k.isShaderMaterial)&&xt.setValue(z,"isOrthographic",C.isOrthographicCamera===!0),K!==C&&(K=C,rn=!0,Un=!0)}if(ke.needsLights&&(wt.state.sunShadowMap.length>0&&xt.setValue(z,"sunShadowMap",wt.state.sunShadowMap,G),wt.state.directionalShadowMap.length>0&&xt.setValue(z,"directionalShadowMap",wt.state.directionalShadowMap,G),wt.state.spotShadowMap.length>0&&xt.setValue(z,"spotShadowMap",wt.state.spotShadowMap,G),wt.state.pointShadowMap.length>0&&xt.setValue(z,"pointShadowMap",wt.state.pointShadowMap,G)),W.isSkinnedMesh){xt.setOptional(z,W,"bindMatrix"),xt.setOptional(z,W,"bindMatrixInverse");let nt=W.skeleton;nt&&(nt.boneTexture===null&&nt.computeBoneTexture(),xt.setValue(z,"boneTexture",nt.boneTexture,G))}W.isBatchedMesh&&(xt.setOptional(z,W,"batchingTexture"),xt.setValue(z,"batchingTexture",W._matricesTexture,G),xt.setOptional(z,W,"batchingIdTexture"),xt.setValue(z,"batchingIdTexture",W._indirectTexture,G),xt.setOptional(z,W,"batchingColorTexture"),W._colorsTexture!==null&&xt.setValue(z,"batchingColorTexture",W._colorsTexture,G));let yt=N.morphAttributes;if((yt.position!==void 0||yt.normal!==void 0||yt.color!==void 0)&&O.update(W,N,Tt),(rn||ke.receiveShadow!==W.receiveShadow)&&(ke.receiveShadow=W.receiveShadow,xt.setValue(z,"receiveShadow",W.receiveShadow)),(k.isMeshStandardMaterial||k.isMeshLambertMaterial||k.isMeshPhongMaterial)&&k.envMap===null&&H.environment!==null&&(St.envMapIntensity.value=H.environmentIntensity),St.dfgLUT!==void 0&&(St.dfgLUT.value=g2()),rn){if(xt.setValue(z,"toneMappingExposure",A.toneMappingExposure),ke.needsLights&&ho(St,Un),ye&&k.fog===!0&&Se.refreshFogUniforms(St,ye),Se.refreshMaterialUniforms(St,k,oe,$,b.state.transmissionRenderTarget[C.id]),ke.needsLights&&ke.lightProbeGrid){let nt=ke.lightProbeGrid;St.probesSH.value=nt.texture,St.probesMin.value.copy(nt.boundingBox.min),St.probesMax.value.copy(nt.boundingBox.max),St.probesResolution.value.copy(nt.resolution)}Ia.upload(z,Ri(ke),St,G)}if(k.isShaderMaterial&&k.uniformsNeedUpdate===!0&&(Ia.upload(z,Ri(ke),St,G),k.uniformsNeedUpdate=!1),k.isSpriteMaterial&&xt.setValue(z,"center",W.center),xt.setValue(z,"modelViewMatrix",W.modelViewMatrix),xt.setValue(z,"normalMatrix",W.normalMatrix),xt.setValue(z,"modelMatrix",W.matrixWorld),k.uniformsGroups!==void 0){let nt=k.uniformsGroups;for(let Xt=0,qt=nt.length;Xt<qt;Xt++){let hr=nt[Xt];ue.update(hr,Tt),ue.bind(hr,Tt)}}return Tt}function ho(C,H){C.ambientLightColor.needsUpdate=H,C.lightProbe.needsUpdate=H,C.sunLights.needsUpdate=H,C.sunLightShadows.needsUpdate=H,C.directionalLights.needsUpdate=H,C.directionalLightShadows.needsUpdate=H,C.pointLights.needsUpdate=H,C.pointLightShadows.needsUpdate=H,C.spotLights.needsUpdate=H,C.spotLightShadows.needsUpdate=H,C.rectAreaLights.needsUpdate=H,C.hemisphereLights.needsUpdate=H}function us(C){return C.isMeshLambertMaterial||C.isMeshToonMaterial||C.isMeshPhongMaterial||C.isMeshStandardMaterial||C.isShadowMaterial||C.isShaderMaterial&&C.lights===!0}this.getActiveCubeFace=function(){return U},this.getActiveMipmapLevel=function(){return X},this.getRenderTarget=function(){return te},this.setRenderTargetTextures=function(C,H,N){let k=J.get(C);k.__autoAllocateDepthBuffer=C.resolveDepthBuffer===!1,k.__autoAllocateDepthBuffer===!1&&(k.__useRenderToTexture=!1),J.get(C.texture).__webglTexture=H,J.get(C.depthTexture).__webglTexture=k.__autoAllocateDepthBuffer?void 0:N,k.__hasExternalTextures=!0},this.setRenderTargetFramebuffer=function(C,H){let N=J.get(C);N.__webglFramebuffer=H,N.__useDefaultFramebuffer=H===void 0},this.setRenderTarget=function(C,H=0,N=0){te=C,U=H,X=N;let k=null,W=!1,ye=!1;if(C){let Ue=J.get(C);if(Ue.__useDefaultFramebuffer!==void 0){w.bindFramebuffer(z.FRAMEBUFFER,Ue.__webglFramebuffer),j.copy(C.viewport),ne.copy(C.scissor),ie=C.scissorTest,w.viewport(j),w.scissor(ne),w.setScissorTest(ie),Z=-1;return}else if(Ue.__webglFramebuffer===void 0)G.setupRenderTarget(C);else if(Ue.__hasExternalTextures)G.rebindTextures(C,J.get(C.texture).__webglTexture,J.get(C.depthTexture).__webglTexture);else if(C.depthBuffer){let ve=C.depthTexture;if(Ue.__boundDepthTexture!==ve){if(ve!==null&&J.has(ve)&&(C.width!==ve.image.width||C.height!==ve.image.height))throw new Error("THREE.WebGLRenderer: Attached DepthTexture is initialized to the incorrect size.");G.setupDepthRenderbuffer(C)}}let Ne=C.texture;(Ne.isData3DTexture||Ne.isDataArrayTexture||Ne.isCompressedArrayTexture)&&(ye=!0);let Y=J.get(C).__webglFramebuffer;C.isWebGLCubeRenderTarget?(Array.isArray(Y[H])?k=Y[H][N]:k=Y[H],W=!0):C.samples>0&&G.useMultisampledRTT(C)===!1?k=J.get(C).__webglMultisampledFramebuffer:Array.isArray(Y)?k=Y[N]:k=Y,j.copy(C.viewport),ne.copy(C.scissor),ie=C.scissorTest}else j.copy(Ee).multiplyScalar(oe).floor(),ne.copy(ze).multiplyScalar(oe).floor(),ie=pt;if(N!==0&&(k=B),w.bindFramebuffer(z.FRAMEBUFFER,k)&&w.drawBuffers(C,k),w.viewport(j),w.scissor(ne),w.setScissorTest(ie),W){let Ue=J.get(C.texture);z.framebufferTexture2D(z.FRAMEBUFFER,z.COLOR_ATTACHMENT0,z.TEXTURE_CUBE_MAP_POSITIVE_X+H,Ue.__webglTexture,N)}else if(ye){let Ue=H;for(let Ne=0;Ne<C.textures.length;Ne++){let Y=J.get(C.textures[Ne]);z.framebufferTextureLayer(z.FRAMEBUFFER,z.COLOR_ATTACHMENT0+Ne,Y.__webglTexture,N,Ue)}}else if(C!==null&&N!==0){let Ue=J.get(C.texture);z.framebufferTexture2D(z.FRAMEBUFFER,z.COLOR_ATTACHMENT0,z.TEXTURE_2D,Ue.__webglTexture,N)}Z=-1};function Tn(C){let H=J.get(C);return(H.__readFormat!==C.format||H.__readType!==C.type)&&(H.__readFormat=C.format,H.__readType=C.type,H.__formatReadable=P.textureFormatReadable(C.format),H.__typeReadable=P.textureTypeReadable(C.type)),H}this.readRenderTargetPixels=function(C,H,N,k,W,ye,Ie,Ue=0){if(!(C&&C.isWebGLRenderTarget)){Qe("WebGLRenderer.readRenderTargetPixels: renderTarget is not THREE.WebGLRenderTarget.");return}let Ne=J.get(C).__webglFramebuffer;if(C.isWebGLCubeRenderTarget&&Ie!==void 0&&(Ne=Ne[Ie]),Ne){w.bindFramebuffer(z.FRAMEBUFFER,Ne);try{let Y=C.textures[Ue],ve=Y.format,Le=Y.type;C.textures.length>1&&z.readBuffer(z.COLOR_ATTACHMENT0+Ue);let ge=Tn(Y);if(ge.__formatReadable===!1){Qe("WebGLRenderer.readRenderTargetPixels: renderTarget is not in RGBA or implementation defined format.");return}if(ge.__typeReadable===!1){Qe("WebGLRenderer.readRenderTargetPixels: renderTarget is not in UnsignedByteType or implementation defined type.");return}H>=0&&H<=C.width-k&&N>=0&&N<=C.height-W&&z.readPixels(H,N,k,W,Pe.convert(ve),Pe.convert(Le),ye)}finally{let Y=te!==null?J.get(te).__webglFramebuffer:null;w.bindFramebuffer(z.FRAMEBUFFER,Y)}}},this.readRenderTargetPixelsAsync=async function(C,H,N,k,W,ye,Ie,Ue=0){if(!(C&&C.isWebGLRenderTarget))throw new Error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not THREE.WebGLRenderTarget.");let Ne=J.get(C).__webglFramebuffer;if(C.isWebGLCubeRenderTarget&&Ie!==void 0&&(Ne=Ne[Ie]),Ne)if(H>=0&&H<=C.width-k&&N>=0&&N<=C.height-W){w.bindFramebuffer(z.FRAMEBUFFER,Ne);let Y=C.textures[Ue],ve=Y.format,Le=Y.type;C.textures.length>1&&z.readBuffer(z.COLOR_ATTACHMENT0+Ue);let ge=Tn(Y);if(ge.__formatReadable===!1)throw new Error("THREE.WebGLRenderer.readRenderTargetPixelsAsync: renderTarget is not in RGBA or implementation defined format.");if(ge.__typeReadable===!1)throw new Error("THREE.WebGLRenderer.readRenderTargetPixelsAsync: renderTarget is not in UnsignedByteType or implementation defined type.");let qe=z.createBuffer();z.bindBuffer(z.PIXEL_PACK_BUFFER,qe),z.bufferData(z.PIXEL_PACK_BUFFER,ye.byteLength,z.STREAM_READ),z.readPixels(H,N,k,W,Pe.convert(ve),Pe.convert(Le),0),z.bindBuffer(z.PIXEL_PACK_BUFFER,null);let $e=te!==null?J.get(te).__webglFramebuffer:null;w.bindFramebuffer(z.FRAMEBUFFER,$e);let tt=z.fenceSync(z.SYNC_GPU_COMMANDS_COMPLETE,0);return z.flush(),await Ev(z,tt,4),z.bindBuffer(z.PIXEL_PACK_BUFFER,qe),z.getBufferSubData(z.PIXEL_PACK_BUFFER,0,ye),z.bindBuffer(z.PIXEL_PACK_BUFFER,null),z.deleteBuffer(qe),z.deleteSync(tt),ye}else throw new Error("THREE.WebGLRenderer.readRenderTargetPixelsAsync: requested read bounds are out of range.")},this.copyFramebufferToTexture=function(C,H=null,N=0){let k=Math.pow(2,-N),W=Math.floor(C.image.width*k),ye=Math.floor(C.image.height*k),Ie=H!==null?H.x:0,Ue=H!==null?H.y:0;G.setTexture2D(C,0),z.copyTexSubImage2D(z.TEXTURE_2D,N,0,0,Ie,Ue,W,ye),w.unbindTexture()},this.copyTextureToTexture=function(C,H,N=null,k=null,W=0,ye=0){let Ie,Ue,Ne,Y,ve,Le,ge,qe,$e,tt=C.isCompressedTexture?C.mipmaps[ye]:C.image;if(N!==null)Ie=N.max.x-N.min.x,Ue=N.max.y-N.min.y,Ne=N.isBox3?N.max.z-N.min.z:1,Y=N.min.x,ve=N.min.y,Le=N.isBox3?N.min.z:0;else{let St=Math.pow(2,-W);Ie=Math.floor(tt.width*St),Ue=Math.floor(tt.height*St),C.isDataArrayTexture?Ne=tt.depth:C.isData3DTexture?Ne=Math.floor(tt.depth*St):Ne=1,Y=0,ve=0,Le=0}k!==null?(ge=k.x,qe=k.y,$e=k.z):(ge=0,qe=0,$e=0);let st=Pe.convert(H.format),It=Pe.convert(H.type),ke;H.isData3DTexture?(G.setTexture3D(H,0),ke=z.TEXTURE_3D):H.isDataArrayTexture||H.isCompressedArrayTexture?(G.setTexture2DArray(H,0),ke=z.TEXTURE_2D_ARRAY):(G.setTexture2D(H,0),ke=z.TEXTURE_2D),w.activeTexture(z.TEXTURE0),w.pixelStorei(z.UNPACK_FLIP_Y_WEBGL,H.flipY),w.pixelStorei(z.UNPACK_PREMULTIPLY_ALPHA_WEBGL,H.premultiplyAlpha),w.pixelStorei(z.UNPACK_ALIGNMENT,H.unpackAlignment);let wt=w.getParameter(z.UNPACK_ROW_LENGTH),ut=w.getParameter(z.UNPACK_IMAGE_HEIGHT),Tt=w.getParameter(z.UNPACK_SKIP_PIXELS),Ot=w.getParameter(z.UNPACK_SKIP_ROWS),rn=w.getParameter(z.UNPACK_SKIP_IMAGES);w.pixelStorei(z.UNPACK_ROW_LENGTH,tt.width),w.pixelStorei(z.UNPACK_IMAGE_HEIGHT,tt.height),w.pixelStorei(z.UNPACK_SKIP_PIXELS,Y),w.pixelStorei(z.UNPACK_SKIP_ROWS,ve),w.pixelStorei(z.UNPACK_SKIP_IMAGES,Le);let Un=C.isDataArrayTexture||C.isData3DTexture,xt=H.isDataArrayTexture||H.isData3DTexture;if(C.isDepthTexture){let St=J.get(C),yt=J.get(H),nt=J.get(St.__renderTarget),Xt=J.get(yt.__renderTarget);w.bindFramebuffer(z.READ_FRAMEBUFFER,nt.__webglFramebuffer),w.bindFramebuffer(z.DRAW_FRAMEBUFFER,Xt.__webglFramebuffer);for(let qt=0;qt<Ne;qt++)Un&&(z.framebufferTextureLayer(z.READ_FRAMEBUFFER,z.COLOR_ATTACHMENT0,J.get(C).__webglTexture,W,Le+qt),z.framebufferTextureLayer(z.DRAW_FRAMEBUFFER,z.COLOR_ATTACHMENT0,J.get(H).__webglTexture,ye,$e+qt)),z.blitFramebuffer(Y,ve,Ie,Ue,ge,qe,Ie,Ue,z.DEPTH_BUFFER_BIT,z.NEAREST);w.bindFramebuffer(z.READ_FRAMEBUFFER,null),w.bindFramebuffer(z.DRAW_FRAMEBUFFER,null)}else if(W!==0||C.isRenderTargetTexture||J.has(C)){let St=J.get(C),yt=J.get(H);w.bindFramebuffer(z.READ_FRAMEBUFFER,F),w.bindFramebuffer(z.DRAW_FRAMEBUFFER,L);for(let nt=0;nt<Ne;nt++)Un?z.framebufferTextureLayer(z.READ_FRAMEBUFFER,z.COLOR_ATTACHMENT0,St.__webglTexture,W,Le+nt):z.framebufferTexture2D(z.READ_FRAMEBUFFER,z.COLOR_ATTACHMENT0,z.TEXTURE_2D,St.__webglTexture,W),xt?z.framebufferTextureLayer(z.DRAW_FRAMEBUFFER,z.COLOR_ATTACHMENT0,yt.__webglTexture,ye,$e+nt):z.framebufferTexture2D(z.DRAW_FRAMEBUFFER,z.COLOR_ATTACHMENT0,z.TEXTURE_2D,yt.__webglTexture,ye),W!==0?z.blitFramebuffer(Y,ve,Ie,Ue,ge,qe,Ie,Ue,z.COLOR_BUFFER_BIT,z.NEAREST):xt?z.copyTexSubImage3D(ke,ye,ge,qe,$e+nt,Y,ve,Ie,Ue):z.copyTexSubImage2D(ke,ye,ge,qe,Y,ve,Ie,Ue);w.bindFramebuffer(z.READ_FRAMEBUFFER,null),w.bindFramebuffer(z.DRAW_FRAMEBUFFER,null)}else xt?C.isDataTexture||C.isData3DTexture?z.texSubImage3D(ke,ye,ge,qe,$e,Ie,Ue,Ne,st,It,tt.data):H.isCompressedArrayTexture?z.compressedTexSubImage3D(ke,ye,ge,qe,$e,Ie,Ue,Ne,st,tt.data):z.texSubImage3D(ke,ye,ge,qe,$e,Ie,Ue,Ne,st,It,tt):C.isDataTexture?z.texSubImage2D(z.TEXTURE_2D,ye,ge,qe,Ie,Ue,st,It,tt.data):C.isCompressedTexture?z.compressedTexSubImage2D(z.TEXTURE_2D,ye,ge,qe,tt.width,tt.height,st,tt.data):z.texSubImage2D(z.TEXTURE_2D,ye,ge,qe,Ie,Ue,st,It,tt);w.pixelStorei(z.UNPACK_ROW_LENGTH,wt),w.pixelStorei(z.UNPACK_IMAGE_HEIGHT,ut),w.pixelStorei(z.UNPACK_SKIP_PIXELS,Tt),w.pixelStorei(z.UNPACK_SKIP_ROWS,Ot),w.pixelStorei(z.UNPACK_SKIP_IMAGES,rn),ye===0&&H.generateMipmaps&&z.generateMipmap(ke),w.unbindTexture()},this.initRenderTarget=function(C){J.get(C).__webglFramebuffer===void 0&&G.setupRenderTarget(C)},this.initTexture=function(C){C.isCubeTexture?G.setTextureCube(C,0):C.isData3DTexture?G.setTexture3D(C,0):C.isDataArrayTexture||C.isCompressedArrayTexture?G.setTexture2DArray(C,0):G.setTexture2D(C,0),w.unbindTexture()},this.resetState=function(){U=0,X=0,te=null,w.reset(),Be.reset()},typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}get coordinateSystem(){return Kn}get outputColorSpace(){return this._outputColorSpace}set outputColorSpace(e){this._outputColorSpace=e;let t=this.getContext();t.drawingBufferColorSpace=vt._getDrawingBufferColorSpace(e),t.unpackColorSpace=vt._getUnpackColorSpace()}};var v2=new Set(["number","boolean","select","color","string"]),du=i=>i==null?i:JSON.parse(JSON.stringify(i));function td(i){return i&&typeof i=="object"&&(Object.values(i).forEach(td),Object.freeze(i)),i}function px(i,e,t){if(e.type==="number"&&(!Number.isFinite(t)||t<e.min||t>e.max))throw new Error(`Parameter ${i} outside range`);if(e.type==="boolean"&&typeof t!="boolean")throw new Error(`Parameter ${i} must be boolean`);if(e.type==="select"&&!e.options.some(n=>(typeof n=="object"?n.value:n)===t))throw new Error(`Parameter ${i} not an option`);if(e.type==="color"&&(typeof t!="string"||!/^#[0-9a-f]{6}$/i.test(t)))throw new Error(`Parameter ${i} must be a hex color`);if(e.type==="string"&&(typeof t!="string"||t.length>(e.maxLength||256)))throw new Error(`Parameter ${i} must be bounded text`);return t}function km(){let i=new Map,e=new Map;function t(a){return i.has(a)?a:e.get(a)}function n(a){let l=i.get(t(a));if(!l)throw new Error(`Unavailable Three.js scene: ${a}`);return l}function r(a){if(!a||a.apiVersion!==1)throw new Error("Incompatible scene API version");if(!/^[a-z][a-z0-9-]*$/.test(a.id||"")||/anime-svg/.test(a.id))throw new Error("Invalid scene ID");if(!Number.isInteger(a.stateVersion)||a.stateVersion<1)throw new Error("Invalid state version");if(typeof a.create!="function")throw new Error("Missing scene factory");if(a.aliases!==void 0&&!Array.isArray(a.aliases))throw new Error("Scene aliases must be an array");for(let d of["camera","capabilities","quality"])if(!a[d]||typeof a[d]!="object"||Array.isArray(a[d]))throw new Error(`Invalid scene ${d}`);let l=a.camera;for(let d of["theta","phi","radius","fov","minRadius","maxRadius"])if(l[d]!==void 0&&!Number.isFinite(l[d]))throw new Error(`Invalid camera ${d}`);if(l.radius!==void 0&&l.radius<=0||l.minRadius!==void 0&&l.minRadius<=0||l.maxRadius!==void 0&&l.maxRadius<=0||l.minRadius!==void 0&&l.maxRadius!==void 0&&l.minRadius>l.maxRadius)throw new Error("Invalid camera radius bounds");if(l.radius!==void 0&&(l.minRadius!==void 0&&l.radius<l.minRadius||l.maxRadius!==void 0&&l.radius>l.maxRadius))throw new Error("Default camera outside radius bounds");if(l.fov!==void 0&&(l.fov<=0||l.fov>=180))throw new Error("Invalid camera FOV");for(let d of["lookAt","position"])if(l[d]!==void 0&&(!Array.isArray(l[d])||l[d].length!==3||!l[d].every(Number.isFinite)))throw new Error(`Invalid camera ${d}`);if(l.fit&&(!Number.isFinite(l.fit.halfWidth)||!Number.isFinite(l.fit.halfHeight)||l.fit.halfWidth<=0||l.fit.halfHeight<=0))throw new Error("Invalid camera framing bounds");for(let d of["label","category","preview"])if(typeof a[d]!="string"||!a[d])throw new Error(`Missing scene ${d}`);if(!a.preview.startsWith("/")||/(?:\.\.|https?:)/.test(a.preview))throw new Error("Preview must be a local absolute asset path");let c=[a.id,...a.aliases||[]];if(new Set(c).size!==c.length)throw new Error("Duplicate scene alias");for(let d of c){if(typeof d!="string"||!d||/anime-svg/.test(d))throw new Error("Invalid scene alias");if(i.has(d)||e.has(d))throw new Error(`Duplicate scene ID or alias: ${d}`)}let u=du(a.params||{});for(let[d,p]of Object.entries(u)){if(!/^[a-z][a-zA-Z0-9]*$/.test(d)||["constructor","prototype"].includes(d))throw new Error(`Invalid parameter key: ${d}`);if(!p||!v2.has(p.type))throw new Error(`Invalid parameter specification: ${d}`);if(p.type==="number"&&(!Number.isFinite(p.min)||!Number.isFinite(p.max)||p.max<p.min||p.step!==void 0&&!(p.step>0)))throw new Error(`Invalid parameter range: ${d}`);if(p.type==="select"&&(!Array.isArray(p.options)||!p.options.length))throw new Error(`Missing parameter options: ${d}`);if(p.type==="select"){let v=p.options.map(g=>g&&typeof g=="object"?g.value:g);if(v.some(g=>!["string","number","boolean"].includes(typeof g)||typeof g=="number"&&!Number.isFinite(g))||new Set(v).size!==v.length)throw new Error(`Invalid parameter options: ${d}`)}if(p.type==="string"&&p.maxLength!==void 0&&(!Number.isInteger(p.maxLength)||p.maxLength<1||p.maxLength>4096))throw new Error(`Invalid text bound: ${d}`);px(d,p,p.default)}if(a.migrateState!==void 0&&typeof a.migrateState!="function")throw new Error("Invalid state migration");let f=td({apiVersion:1,id:a.id,stateVersion:a.stateVersion,label:a.label,category:a.category,preview:a.preview,aliases:c.slice(1),params:u,camera:du(a.camera||{}),capabilities:du(a.capabilities||{}),quality:du(a.quality||{})}),h=Object.freeze({...f,create:a.create,migrateState:a.migrateState,metadata:f});return i.set(a.id,h),c.slice(1).forEach(d=>e.set(d,a.id)),f}function s(a,l,c){let u=n(a);if(!l||typeof l!="object"||Array.isArray(l))throw new Error("Parameters must be an object");let f={};for(let h of Object.keys(l))if(!Object.hasOwn(u.params,h))throw new Error(`Unknown parameter: ${h}`);for(let[h,d]of Object.entries(u.params)){let p=Object.hasOwn(l,h)?l[h]:c&&Object.hasOwn(c,h)?c[h]:d.default;f[h]=px(h,d,p)}return td(f)}function o(a,l={}){let c=n(a);if(!l||typeof l!="object"||Array.isArray(l))throw new Error("Invalid scene state");let u=du(l),f=u.stateVersion===void 0?c.stateVersion:u.stateVersion;if(!Number.isInteger(f)||f<1||f>c.stateVersion)throw new Error("Unsupported scene state version");if(f<c.stateVersion){if(!c.migrateState)throw new Error("Scene state migration unavailable");if(u=c.migrateState(u,f,c.stateVersion),!u||u.stateVersion!==c.stateVersion)throw new Error("Migration did not produce current scene state")}let h=s(c.id,u.params===void 0?{}:u.params);return td({id:c.id,stateVersion:c.stateVersion,params:h})}return Object.freeze({register:r,get:n,resolve:t,validateParams:s,normalizeState:o,catalog:()=>Object.freeze([...i.values()].map(a=>a.metadata))})}function nd(){let i=new AbortController,e=new Set,t=new Set,n=new Set,r=!1;function s(c){if(typeof c!="function")throw new Error("Cleanup must be a function");return r?c():t.add(c),c}function o(c){if(!c||typeof c.dispose!="function")throw new Error("Resource must be disposable");return e.has(c)||(r?c.dispose():e.add(c)),c}function a(c){return c.traverse(u=>{u.isInstancedMesh&&o(u),u.geometry&&o(u.geometry);let f=Array.isArray(u.material)?u.material:u.material?[u.material]:[];for(let h of f)o(h),Object.values(h).forEach(d=>{d&&d.isTexture&&!d.userData?.spaceShared&&o(d)}),Object.values(h.uniforms||{}).forEach(d=>{d.value&&d.value.isTexture&&!d.value.userData?.spaceShared&&o(d.value)});u.shadow&&u.shadow.map&&o(u.shadow.map)}),c}function l(){let c=0;for(let u of e)if(u.isBufferGeometry){let f=new Set(Object.values(u.attributes||{}).map(h=>h.array));u.index&&f.add(u.index.array),f.forEach(h=>{c+=h?h.byteLength:0})}else if(u.isTexture){let f=u.image||{};c+=(f.width||0)*(f.height||0)*4*1.333}else u.isWebGLRenderTarget?c+=u.width*u.height*8:u.isInstancedMesh&&(c+=u.instanceMatrix.array.byteLength+(u.instanceColor?u.instanceColor.array.byteLength:0));return{resources:e.size,tasks:n.size,cleanups:t.size,estimatedBytes:Math.round(c)}}return{signal:i.signal,track:o,trackTree:a,defer:s,stats:l,release(c){e.delete(c)&&c.dispose()},listen(c,u,f,h){return c.addEventListener(u,f,h),s(()=>c.removeEventListener(u,f,h)),f},timeout(c,u){if(r)return null;let f=setTimeout(()=>{n.delete(f),r||c()},u);return n.add(f),f},abortController(){let c=new AbortController;return s(()=>c.abort()),c},dispose(){r||(r=!0,i.abort(),n.forEach(clearTimeout),n.clear(),[...t].reverse().forEach(c=>{try{c()}catch{}}),t.clear(),[...e].reverse().forEach(c=>{try{c.dispose()}catch{}}),e.clear())}}}var Gm=Object.freeze({low:Object.freeze({mode:"low",fps:30,density:.4,dprCap:.85,pixelBudget:1e6,drawCalls:40,particles:12e3,triangles:8e4,memoryBytes:67108864,post:!1}),medium:Object.freeze({mode:"medium",fps:60,density:.7,dprCap:1,pixelBudget:21e5,drawCalls:80,particles:3e4,triangles:2e5,memoryBytes:134217728,post:!0}),high:Object.freeze({mode:"high",fps:60,density:1,dprCap:1.25,pixelBudget:33e5,drawCalls:120,particles:5e4,triangles:4e5,memoryBytes:201326592,post:!0})}),Dr=["low","medium","high"];function id(i){return["auto",...Dr].includes(i)?i:"auto"}function mx(i="auto",e=1){let t=d=>typeof d=="string"&&Dr.includes(d)?Dr.indexOf(d):Number.isFinite(Number(d))?Math.max(0,Math.min(2,Math.floor(Number(d)))):1,n=t(e),r=id(i),s=0,o="",a=null,l=0,c=null,u=[],f=0;function h(d=null){s=Math.min(n,r==="auto"?1:Dr.indexOf(r)),o=s<(r==="auto"?1:Dr.indexOf(r))?"device-ceiling":"",a=d,l=d||0,c=null,u=[],f=0}return h(),{profile:()=>Gm[Dr[s]],status:()=>({qualityMode:r,effectiveQuality:Dr[s],qualityReason:o}),setMode(d){r=id(d),h()},setDeviceTier(d){return n=Math.min(n,t(d)),s<=n?!1:(s=n,o="device-ceiling",f=0,!0)},warmup(d){a=d,l=d||0,u=[],c=null,f=0},dpr(d,p,v=1){let g=Gm[Dr[s]];return Math.min(v,g.dprCap,Math.sqrt(g.pixelBudget/Math.max(1,d*p)))},sample(d,p,v){if(a===null&&(a=d,l=d),c!==null&&d>c&&u.push(d-c),c=d,d-a<1e4||d-l<2e3)return!1;let g=Gm[Dr[s]];typeof p=="function"&&(p=p());let m=u.slice().sort((x,S)=>x-S),y=m[Math.floor(m.length*.95)]||0;return f=m.length>=10&&(y>1e3/g.fps*1.4||v>1e3/g.fps*.8||p.drawCalls>g.drawCalls||p.points>g.particles||p.triangles>g.triangles||p.estimatedBytes>g.memoryBytes)?f+1:0,l=d,u=[],f>=3&&s>0?(s--,o="sustained-frame-or-resource-pressure",f=0,!0):!1}}}var Da={name:"CopyShader",uniforms:{tDiffuse:{value:null},opacity:{value:1}},vertexShader:`

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		uniform float opacity;

		uniform sampler2D tDiffuse;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );
			gl_FragColor = opacity * texel;


		}`};var di=class{constructor(){this.isPass=!0,this.enabled=!0,this.needsSwap=!0,this.clear=!1,this.renderToScreen=!1}setSize(){}render(){console.error("THREE.Pass: .render() must be implemented in derived pass.")}dispose(){}},x2=new tr(-1,1,1,-1,0,1),Vm=class extends et{constructor(){super(),this.setAttribute("position",new Ve([-1,3,0,-1,-1,0,3,-1,0],3)),this.setAttribute("uv",new Ve([0,2,0,0,2,0],2))}},y2=new Vm,ss=class{constructor(e){this._mesh=new at(y2,e)}dispose(){this._mesh.geometry.dispose()}render(e){e.render(this._mesh,x2)}get material(){return this._mesh.material}set material(e){this._mesh.material=e}};var Na=class extends di{constructor(e,t="tDiffuse"){super(),this.textureID=t,this.uniforms=null,this.material=null,e instanceof Lt?(this.uniforms=e.uniforms,this.material=e):e&&(this.uniforms=rr.clone(e.uniforms),this.material=new Lt({name:e.name!==void 0?e.name:"unspecified",defines:Object.assign({},e.defines),uniforms:this.uniforms,vertexShader:e.vertexShader,fragmentShader:e.fragmentShader})),this._fsQuad=new ss(this.material)}render(e,t,n){this.uniforms[this.textureID]&&(this.uniforms[this.textureID].value=n.texture),this._fsQuad.material=this.material,this.renderToScreen?(e.setRenderTarget(null),this._fsQuad.render(e)):(e.setRenderTarget(t),this.clear&&e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil),this._fsQuad.render(e))}dispose(){this.material.dispose(),this._fsQuad.dispose()}};var pu=class extends di{constructor(e,t){super(),this.scene=e,this.camera=t,this.clear=!0,this.needsSwap=!1,this.inverse=!1}render(e,t,n){let r=e.getContext(),s=e.state;s.buffers.color.setMask(!1),s.buffers.depth.setMask(!1),s.buffers.color.setLocked(!0),s.buffers.depth.setLocked(!0);let o,a;this.inverse?(o=0,a=1):(o=1,a=0),s.buffers.stencil.setTest(!0),s.buffers.stencil.setOp(r.REPLACE,r.REPLACE,r.REPLACE),s.buffers.stencil.setFunc(r.ALWAYS,o,4294967295),s.buffers.stencil.setClear(a),s.buffers.stencil.setLocked(!0),e.setRenderTarget(n),this.clear&&e.clear(),e.render(this.scene,this.camera),e.setRenderTarget(t),this.clear&&e.clear(),e.render(this.scene,this.camera),s.buffers.color.setLocked(!1),s.buffers.depth.setLocked(!1),s.buffers.color.setMask(!0),s.buffers.depth.setMask(!0),s.buffers.stencil.setLocked(!1),s.buffers.stencil.setFunc(r.EQUAL,1,4294967295),s.buffers.stencil.setOp(r.KEEP,r.KEEP,r.KEEP),s.buffers.stencil.setLocked(!0)}},rd=class extends di{constructor(){super(),this.needsSwap=!1}render(e){e.state.buffers.stencil.setLocked(!1),e.state.buffers.stencil.setTest(!1)}};var sd=class{constructor(e,t){if(this.renderer=e,this._pixelRatio=e.getPixelRatio(),t===void 0){let n=e.getSize(new he);this._width=n.width,this._height=n.height,t=new Gt(this._width*this._pixelRatio,this._height*this._pixelRatio,{type:ln}),t.texture.name="EffectComposer.rt1"}else this._width=t.width,this._height=t.height;this.renderTarget1=t,this.renderTarget2=t.clone(),this.renderTarget2.texture.name="EffectComposer.rt2",this.writeBuffer=this.renderTarget1,this.readBuffer=this.renderTarget2,this.renderToScreen=!0,this.passes=[],this.copyPass=new Na(Da),this.copyPass.material.blending=ui,this.timer=new Xs}swapBuffers(){let e=this.readBuffer;this.readBuffer=this.writeBuffer,this.writeBuffer=e}addPass(e){this.passes.push(e),e.setSize(this._width*this._pixelRatio,this._height*this._pixelRatio)}insertPass(e,t){this.passes.splice(t,0,e),e.setSize(this._width*this._pixelRatio,this._height*this._pixelRatio)}removePass(e){let t=this.passes.indexOf(e);t!==-1&&this.passes.splice(t,1)}isLastEnabledPass(e){for(let t=e+1;t<this.passes.length;t++)if(this.passes[t].enabled)return!1;return!0}render(e){this.timer.update(),e===void 0&&(e=this.timer.getDelta());let t=this.renderer.getRenderTarget(),n=!1;for(let r=0,s=this.passes.length;r<s;r++){let o=this.passes[r];if(o.enabled!==!1){if(o.renderToScreen=this.renderToScreen&&this.isLastEnabledPass(r),o.render(this.renderer,this.writeBuffer,this.readBuffer,e,n),o.needsSwap){if(n){let a=this.renderer.getContext(),l=this.renderer.state.buffers.stencil;l.setFunc(a.NOTEQUAL,1,4294967295),this.copyPass.render(this.renderer,this.writeBuffer,this.readBuffer,e),l.setFunc(a.EQUAL,1,4294967295)}this.swapBuffers()}pu!==void 0&&(o instanceof pu?n=!0:o instanceof rd&&(n=!1))}}this.renderer.setRenderTarget(t)}reset(e){if(e===void 0){let t=this.renderer.getSize(new he);this._pixelRatio=this.renderer.getPixelRatio(),this._width=t.width,this._height=t.height,e=this.renderTarget1.clone(),e.setSize(this._width*this._pixelRatio,this._height*this._pixelRatio)}this.renderTarget1.dispose(),this.renderTarget2.dispose(),this.renderTarget1=e,this.renderTarget2=e.clone(),this.writeBuffer=this.renderTarget1,this.readBuffer=this.renderTarget2}setSize(e,t){this._width=e,this._height=t;let n=this._width*this._pixelRatio,r=this._height*this._pixelRatio;this.renderTarget1.setSize(n,r),this.renderTarget2.setSize(n,r);for(let s=0;s<this.passes.length;s++)this.passes[s].setSize(n,r)}setPixelRatio(e){this._pixelRatio=e,this.setSize(this._width,this._height)}dispose(){this.renderTarget1.dispose(),this.renderTarget2.dispose(),this.copyPass.dispose()}};var od=class extends di{constructor(e,t,n=null,r=null,s=null){super(),this.scene=e,this.camera=t,this.overrideMaterial=n,this.clearColor=r,this.clearAlpha=s,this.clear=!0,this.clearDepth=!1,this.needsSwap=!1,this.isRenderPass=!0,this._oldClearColor=new be}render(e,t,n){let r=e.autoClear;e.autoClear=!1;let s,o;this.overrideMaterial!==null&&(o=this.scene.overrideMaterial,this.scene.overrideMaterial=this.overrideMaterial),this.clearColor!==null&&(e.getClearColor(this._oldClearColor),e.setClearColor(this.clearColor,e.getClearAlpha())),this.clearAlpha!==null&&(s=e.getClearAlpha(),e.setClearAlpha(this.clearAlpha)),this.clearDepth==!0&&e.clearDepth(),e.setRenderTarget(this.renderToScreen?null:n),this.clear===!0&&e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil),e.render(this.scene,this.camera),this.clearColor!==null&&e.setClearColor(this._oldClearColor),this.clearAlpha!==null&&e.setClearAlpha(s),this.overrideMaterial!==null&&(this.scene.overrideMaterial=o),e.autoClear=r}};var gx={name:"LuminosityHighPassShader",uniforms:{tDiffuse:{value:null},luminosityThreshold:{value:1},smoothWidth:{value:1},defaultColor:{value:new be(0)},defaultOpacity:{value:0}},vertexShader:`

		varying vec2 vUv;

		void main() {

			vUv = uv;

			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		uniform sampler2D tDiffuse;
		uniform vec3 defaultColor;
		uniform float defaultOpacity;
		uniform float luminosityThreshold;
		uniform float smoothWidth;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );

			float v = luminance( texel.xyz );

			vec4 outputColor = vec4( defaultColor.rgb, defaultOpacity );

			float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v );

			gl_FragColor = mix( outputColor, texel, alpha );

		}`};var Fa=class i extends di{constructor(e,t=1,n,r){super(),this.strength=t,this.radius=n,this.threshold=r,this.resolution=e!==void 0?new he(e.x,e.y):new he(256,256),this.clearColor=new be(0,0,0),this.needsSwap=!1,this.renderTargetsHorizontal=[],this.renderTargetsVertical=[],this.nMips=5;let s=Math.round(this.resolution.x/2),o=Math.round(this.resolution.y/2);this.renderTargetBright=new Gt(s,o,{type:ln,depthBuffer:!1}),this.renderTargetBright.texture.name="UnrealBloomPass.bright",this.renderTargetBright.texture.generateMipmaps=!1;for(let u=0;u<this.nMips;u++){let f=new Gt(s,o,{type:ln,depthBuffer:!1});f.texture.name="UnrealBloomPass.h"+u,f.texture.generateMipmaps=!1,this.renderTargetsHorizontal.push(f);let h=new Gt(s,o,{type:ln,depthBuffer:!1});h.texture.name="UnrealBloomPass.v"+u,h.texture.generateMipmaps=!1,this.renderTargetsVertical.push(h),s=Math.round(s/2),o=Math.round(o/2)}let a=gx;this.highPassUniforms=rr.clone(a.uniforms),this.highPassUniforms.luminosityThreshold.value=r,this.highPassUniforms.smoothWidth.value=.01,this.materialHighPassFilter=new Lt({uniforms:this.highPassUniforms,vertexShader:a.vertexShader,fragmentShader:a.fragmentShader}),this.separableBlurMaterials=[];let l=[6,10,14,18,22];s=Math.round(this.resolution.x/2),o=Math.round(this.resolution.y/2);for(let u=0;u<this.nMips;u++)this.separableBlurMaterials.push(this._getSeparableBlurMaterial(l[u])),this.separableBlurMaterials[u].uniforms.invSize.value=new he(1/s,1/o),s=Math.round(s/2),o=Math.round(o/2);this.compositeMaterial=this._getCompositeMaterial(this.nMips),this.compositeMaterial.uniforms.blurTexture1.value=this.renderTargetsVertical[0].texture,this.compositeMaterial.uniforms.blurTexture2.value=this.renderTargetsVertical[1].texture,this.compositeMaterial.uniforms.blurTexture3.value=this.renderTargetsVertical[2].texture,this.compositeMaterial.uniforms.blurTexture4.value=this.renderTargetsVertical[3].texture,this.compositeMaterial.uniforms.blurTexture5.value=this.renderTargetsVertical[4].texture,this.compositeMaterial.uniforms.bloomStrength.value=t,this.compositeMaterial.uniforms.bloomRadius.value=.1;let c=[1,.8,.6,.4,.2];this.compositeMaterial.uniforms.bloomFactors.value=c,this.bloomTintColors=[new R(1,1,1),new R(1,1,1),new R(1,1,1),new R(1,1,1),new R(1,1,1)],this.compositeMaterial.uniforms.bloomTintColors.value=this.bloomTintColors,this.copyUniforms=rr.clone(Da.uniforms),this.blendMaterial=new Lt({uniforms:this.copyUniforms,vertexShader:Da.vertexShader,fragmentShader:Da.fragmentShader,premultipliedAlpha:!0,blending:Cr,depthTest:!1,depthWrite:!1,transparent:!0}),this._oldClearColor=new be,this._oldClearAlpha=1,this._basic=new Hn,this._fsQuad=new ss(null)}dispose(){for(let e=0;e<this.renderTargetsHorizontal.length;e++)this.renderTargetsHorizontal[e].dispose();for(let e=0;e<this.renderTargetsVertical.length;e++)this.renderTargetsVertical[e].dispose();this.renderTargetBright.dispose();for(let e=0;e<this.separableBlurMaterials.length;e++)this.separableBlurMaterials[e].dispose();this.compositeMaterial.dispose(),this.blendMaterial.dispose(),this._basic.dispose(),this._fsQuad.dispose()}setSize(e,t){let n=Math.round(e/2),r=Math.round(t/2);this.renderTargetBright.setSize(n,r);for(let s=0;s<this.nMips;s++)this.renderTargetsHorizontal[s].setSize(n,r),this.renderTargetsVertical[s].setSize(n,r),this.separableBlurMaterials[s].uniforms.invSize.value=new he(1/n,1/r),n=Math.round(n/2),r=Math.round(r/2)}render(e,t,n,r,s){e.getClearColor(this._oldClearColor),this._oldClearAlpha=e.getClearAlpha();let o=e.autoClear;e.autoClear=!1,e.setClearColor(this.clearColor,0),s&&e.state.buffers.stencil.setTest(!1),this.renderToScreen&&(this._fsQuad.material=this._basic,this._basic.map=n.texture,e.setRenderTarget(null),e.clear(),this._fsQuad.render(e)),this.highPassUniforms.tDiffuse.value=n.texture,this.highPassUniforms.luminosityThreshold.value=this.threshold,this._fsQuad.material=this.materialHighPassFilter,e.setRenderTarget(this.renderTargetBright),e.clear(),this._fsQuad.render(e);let a=this.renderTargetBright;for(let l=0;l<this.nMips;l++)this._fsQuad.material=this.separableBlurMaterials[l],this.separableBlurMaterials[l].uniforms.colorTexture.value=a.texture,this.separableBlurMaterials[l].uniforms.direction.value=i.BlurDirectionX,e.setRenderTarget(this.renderTargetsHorizontal[l]),e.clear(),this._fsQuad.render(e),this.separableBlurMaterials[l].uniforms.colorTexture.value=this.renderTargetsHorizontal[l].texture,this.separableBlurMaterials[l].uniforms.direction.value=i.BlurDirectionY,e.setRenderTarget(this.renderTargetsVertical[l]),e.clear(),this._fsQuad.render(e),a=this.renderTargetsVertical[l];this._fsQuad.material=this.compositeMaterial,this.compositeMaterial.uniforms.bloomStrength.value=this.strength,this.compositeMaterial.uniforms.bloomRadius.value=this.radius,this.compositeMaterial.uniforms.bloomTintColors.value=this.bloomTintColors,e.setRenderTarget(this.renderTargetsHorizontal[0]),e.clear(),this._fsQuad.render(e),this._fsQuad.material=this.blendMaterial,this.copyUniforms.tDiffuse.value=this.renderTargetsHorizontal[0].texture,s&&e.state.buffers.stencil.setTest(!0),this.renderToScreen?(e.setRenderTarget(null),this._fsQuad.render(e)):(e.setRenderTarget(n),this._fsQuad.render(e)),e.setClearColor(this._oldClearColor,this._oldClearAlpha),e.autoClear=o}_getSeparableBlurMaterial(e){let t=[],n=e/3;for(let o=0;o<e;o++)t.push(.39894*Math.exp(-.5*o*o/(n*n))/n);let r=[],s=[];for(let o=1;o<e;o+=2){let a=t[o],l=o+1<e?t[o+1]:0,c=a+l;r.push((o*a+(o+1)*l)/c),s.push(c)}return new Lt({defines:{KERNEL_PAIRS:r.length},uniforms:{colorTexture:{value:null},invSize:{value:new he(.5,.5)},direction:{value:new he(.5,.5)},centerWeight:{value:t[0]},gaussianOffsets:{value:r},gaussianWeights:{value:s}},vertexShader:`

				varying vec2 vUv;

				void main() {

					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}`,fragmentShader:`

				#include <common>

				varying vec2 vUv;

				uniform sampler2D colorTexture;
				uniform vec2 invSize;
				uniform vec2 direction;
				uniform float centerWeight;
				uniform float gaussianOffsets[KERNEL_PAIRS];
				uniform float gaussianWeights[KERNEL_PAIRS];

				void main() {

					vec3 diffuseSum = texture2D( colorTexture, vUv ).rgb * centerWeight;

					for ( int i = 0; i < KERNEL_PAIRS; i ++ ) {

						vec2 uvOffset = direction * invSize * gaussianOffsets[ i ];
						vec3 sample1 = texture2D( colorTexture, vUv + uvOffset ).rgb;
						vec3 sample2 = texture2D( colorTexture, vUv - uvOffset ).rgb;
						diffuseSum += ( sample1 + sample2 ) * gaussianWeights[ i ];

					}

					gl_FragColor = vec4( diffuseSum, 1.0 );

				}`})}_getCompositeMaterial(e){return new Lt({defines:{NUM_MIPS:e},uniforms:{blurTexture1:{value:null},blurTexture2:{value:null},blurTexture3:{value:null},blurTexture4:{value:null},blurTexture5:{value:null},bloomStrength:{value:1},bloomFactors:{value:null},bloomTintColors:{value:null},bloomRadius:{value:0}},vertexShader:`

				varying vec2 vUv;

				void main() {

					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}`,fragmentShader:`

				varying vec2 vUv;

				uniform sampler2D blurTexture1;
				uniform sampler2D blurTexture2;
				uniform sampler2D blurTexture3;
				uniform sampler2D blurTexture4;
				uniform sampler2D blurTexture5;
				uniform float bloomStrength;
				uniform float bloomRadius;
				uniform float bloomFactors[NUM_MIPS];
				uniform vec3 bloomTintColors[NUM_MIPS];

				float lerpBloomFactor( const in float factor ) {

					float mirrorFactor = 1.2 - factor;
					return mix( factor, mirrorFactor, bloomRadius );

				}

				void main() {

					// 3.0 for backwards compatibility with previous alpha-based intensity
					vec3 bloom = 3.0 * bloomStrength * (
						lerpBloomFactor( bloomFactors[ 0 ] ) * bloomTintColors[ 0 ] * texture2D( blurTexture1, vUv ).rgb +
						lerpBloomFactor( bloomFactors[ 1 ] ) * bloomTintColors[ 1 ] * texture2D( blurTexture2, vUv ).rgb +
						lerpBloomFactor( bloomFactors[ 2 ] ) * bloomTintColors[ 2 ] * texture2D( blurTexture3, vUv ).rgb +
						lerpBloomFactor( bloomFactors[ 3 ] ) * bloomTintColors[ 3 ] * texture2D( blurTexture4, vUv ).rgb +
						lerpBloomFactor( bloomFactors[ 4 ] ) * bloomTintColors[ 4 ] * texture2D( blurTexture5, vUv ).rgb
					);

					float bloomAlpha = max( bloom.r, max( bloom.g, bloom.b ) );
					gl_FragColor = vec4( bloom, bloomAlpha );

				}`})}};Fa.BlurDirectionX=new he(1,0);Fa.BlurDirectionY=new he(0,1);var mu={name:"OutputShader",uniforms:{tDiffuse:{value:null},toneMappingExposure:{value:1}},vertexShader:`
		precision highp float;

		uniform mat4 modelViewMatrix;
		uniform mat4 projectionMatrix;

		attribute vec3 position;
		attribute vec2 uv;

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		precision highp float;

		uniform sampler2D tDiffuse;

		#include <tonemapping_pars_fragment>
		#include <colorspace_pars_fragment>

		varying vec2 vUv;

		void main() {

			gl_FragColor = texture2D( tDiffuse, vUv );

			// tone mapping

			#ifdef LINEAR_TONE_MAPPING

				gl_FragColor.rgb = LinearToneMapping( gl_FragColor.rgb );

			#elif defined( REINHARD_TONE_MAPPING )

				gl_FragColor.rgb = ReinhardToneMapping( gl_FragColor.rgb );

			#elif defined( CINEON_TONE_MAPPING )

				gl_FragColor.rgb = CineonToneMapping( gl_FragColor.rgb );

			#elif defined( ACES_FILMIC_TONE_MAPPING )

				gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );

			#elif defined( AGX_TONE_MAPPING )

				gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );

			#elif defined( NEUTRAL_TONE_MAPPING )

				gl_FragColor.rgb = NeutralToneMapping( gl_FragColor.rgb );

			#elif defined( CUSTOM_TONE_MAPPING )

				gl_FragColor.rgb = CustomToneMapping( gl_FragColor.rgb );

			#endif

			// color space

			#ifdef SRGB_TRANSFER

				gl_FragColor = sRGBTransferOETF( gl_FragColor );

			#endif

		}`};var ad=class extends di{constructor(){super(),this.isOutputPass=!0,this.uniforms=rr.clone(mu.uniforms),this.material=new Qr({name:mu.name,uniforms:this.uniforms,vertexShader:mu.vertexShader,fragmentShader:mu.fragmentShader}),this._fsQuad=new ss(this.material),this._outputColorSpace=null,this._toneMapping=null}render(e,t,n){this.uniforms.tDiffuse.value=n.texture,this.uniforms.toneMappingExposure.value=e.toneMappingExposure,(this._outputColorSpace!==e.outputColorSpace||this._toneMapping!==e.toneMapping)&&(this._outputColorSpace=e.outputColorSpace,this._toneMapping=e.toneMapping,this.material.defines={},vt.getTransfer(this._outputColorSpace)===bt&&(this.material.defines.SRGB_TRANSFER=""),this._toneMapping===da?this.material.defines.LINEAR_TONE_MAPPING="":this._toneMapping===pa?this.material.defines.REINHARD_TONE_MAPPING="":this._toneMapping===ma?this.material.defines.CINEON_TONE_MAPPING="":this._toneMapping===rs?this.material.defines.ACES_FILMIC_TONE_MAPPING="":this._toneMapping===va?this.material.defines.AGX_TONE_MAPPING="":this._toneMapping===xa?this.material.defines.NEUTRAL_TONE_MAPPING="":this._toneMapping===ga&&(this.material.defines.CUSTOM_TONE_MAPPING=""),this.material.needsUpdate=!0),this.renderToScreen===!0?(e.setRenderTarget(null),this._fsQuad.render(e)):(e.setRenderTarget(t),this.clear&&e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil),this._fsQuad.render(e))}dispose(){this.material.dispose(),this._fsQuad.dispose()}};var or=Math.PI*2,Sn=(i,e,t)=>Math.min(t,Math.max(e,i)),bn=(i,e,t)=>i+(e-i)*t,Ht=(i,e,t)=>{let n=Sn((t-i)/(e-i),0,1);return n*n*(3-2*n)},os=(i,e,t,n)=>bn(i,e,1-Math.exp(-t*n));function no(i){let e=i|0;return function(){e=e+1831565813|0;let t=Math.imul(e^e>>>15,1|e);return t=t+Math.imul(t^t>>>7,61|t)^t,((t^t>>>14)>>>0)/4294967296}}function pi(i,e,t){return new R(i,e,t)}function Hm({segs:i=32,ring:e=16,center:t,section:n,color:r}){let s=[],o=[],a=[],l=[],c=new be;for(let f=0;f<=i;f++){let h=f/i,d=t(h);for(let p=0;p<=e;p++){let v=p/e,[g,m]=n(h,v);s.push(d.x,d.y+g,d.z+m),o.push(h,v),r&&(r(h,v,c),a.push(c.r,c.g,c.b))}}for(let f=0;f<i;f++)for(let h=0;h<e;h++){let d=f*(e+1)+h,p=d+e+1;l.push(d,d+1,p,p,d+1,p+1)}let u=new et;return u.setAttribute("position",new Ve(s,3)),u.setAttribute("uv",new Ve(o,2)),r&&u.setAttribute("color",new Ve(a,3)),u.setIndex(l),u.computeVertexNormals(),u}var gu=class{constructor(e,t,n){this.tub=e,this.rad=t,this.radiusFn=n;let r=(e+1)*(t+1);this.pos=new Float32Array(r*3),this.nor=new Float32Array(r*3);let s=new Float32Array(r*2),o=[];for(let u=0;u<=e;u++)for(let f=0;f<=t;f++){let h=u*(t+1)+f;s[h*2]=u/e,s[h*2+1]=f/t}for(let u=0;u<e;u++)for(let f=0;f<t;f++){let h=u*(t+1)+f,d=h+t+1;o.push(h,h+1,d,d,h+1,d+1)}let a=new et,l=new ht(this.pos,3),c=new ht(this.nor,3);l.setUsage(lu),c.setUsage(lu),a.setAttribute("position",l),a.setAttribute("normal",c),a.setAttribute("uv",new ht(s,2)),a.setIndex(o),this.geometry=a,this.curve=new Us([pi(0,0,0),pi(0,1,0)],!1,"centripetal"),this._P=[],this._T=[];for(let u=0;u<=e;u++)this._P.push(new R),this._T.push(new R);this._N=new R,this._B=new R,this._d=new R}update(e){let{tub:t,rad:n,pos:r,nor:s,_P:o,_T:a,_N:l,_B:c,_d:u}=this;this.curve.points=e;for(let h=0;h<=t;h++)this.curve.getPoint(h/t,o[h]);for(let h=0;h<=t;h++){let d=o[Math.max(0,h-1)],p=o[Math.min(t,h+1)];a[h].subVectors(p,d).normalize()}let f=a[0];l.set(0,0,1),Math.abs(f.dot(l))>.9&&l.set(1,0,0),l.addScaledVector(f,-f.dot(l)).normalize();for(let h=0;h<=t;h++){let d=a[h];h>0&&l.addScaledVector(d,-d.dot(l)).normalize(),c.crossVectors(d,l);let p=this.radiusFn(h/t),v=o[h];for(let g=0;g<=n;g++){let m=g/n*or,y=Math.cos(m),_=Math.sin(m);u.set(l.x*y+c.x*_,l.y*y+c.y*_,l.z*y+c.z*_);let x=(h*(n+1)+g)*3;r[x]=v.x+u.x*p,r[x+1]=v.y+u.y*p,r[x+2]=v.z+u.z*p,s[x]=u.x,s[x+1]=u.y,s[x+2]=u.z}}this.geometry.attributes.position.needsUpdate=!0,this.geometry.attributes.normal.needsUpdate=!0}};function Nt(i,e){let t=new be(e),n=i.attributes.position.count,r=new Float32Array(n*3);for(let s=0;s<n;s++)r[s*3]=t.r,r[s*3+1]=t.g,r[s*3+2]=t.b;return i.setAttribute("color",new ht(r,3)),i}function Et(i){let e=i.index?i.toNonIndexed():i;for(let t of Object.keys(e.attributes))t!=="position"&&t!=="normal"&&t!=="color"&&e.deleteAttribute(t);return e.attributes.normal||e.computeVertexNormals(),e.attributes.color||Nt(e,16777215),e.morphAttributes={},e}var wn={uSunDir:{value:new R(.5,.3,-.8).normalize()},uMoonDir:{value:new R(-.5,.5,.7).normalize()},uZenith:{value:new be},uHorizon:{value:new be},uGround:{value:new be},uSunColor:{value:new be},uSunGlow:{value:1},uNight:{value:0},uTime:{value:0},uCloudOffset:{value:new he},uCloudCover:{value:.45},uCloudTint:{value:new be},uCloudShade:{value:new be}},Wm=`
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform float uSunGlow;
uniform float uNight;
uniform float uTime;

vec3 skyBase(vec3 dir) {
  float y = dir.y;
  float h = pow(1.0 - clamp(y, 0.0, 1.0), 3.5);
  vec3 col = mix(uZenith, uHorizon, h);
  if (y < 0.0) col = mix(uHorizon, uGround, smoothstep(0.0, -0.3, y));
  float sd = max(dot(dir, uSunDir), 0.0);
  float glow = pow(sd, 6.0) * 0.28 + pow(sd, 48.0) * 0.55 + pow(sd, 400.0) * 1.2;
  col += uSunColor * glow * uSunGlow * (0.45 + 0.55 * h);
  float md = max(dot(dir, uMoonDir), 0.0);
  col += vec3(0.35, 0.45, 0.7) * (pow(md, 24.0) * 0.05 + pow(md, 300.0) * 0.2) * uNight;
  return col;
}
`,vx=`
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return s;
}
`,xx=vx,_2=`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`,M2=`
${Wm}
${vx}
uniform vec2 uCloudOffset;
uniform float uCloudCover;
uniform vec3 uCloudTint;
uniform vec3 uCloudShade;
uniform float uDetail;
varying vec3 vDir;

void main() {
  vec3 dir = normalize(vDir);
  vec3 col = skyBase(dir);

  // \u661F\u7A7A + \u94F6\u6CB3
  if (uNight > 0.01 && dir.y > -0.05) {
    vec3 p = dir * 320.0;
    vec3 cell = floor(p);
    float h = hash13(cell);
    if (h > 0.9955) {
      vec3 c = cell + 0.5 + (vec3(hash13(cell + 1.3), hash13(cell + 7.1), hash13(cell + 3.7)) - 0.5) * 0.7;
      float d = length(p - c);
      float star = smoothstep(0.42, 0.0, d);
      float tw = 0.55 + 0.45 * sin(uTime * (1.5 + h * 7.0) + h * 91.0);
      vec3 sc = mix(vec3(1.0, 0.82, 0.7), vec3(0.75, 0.85, 1.0), hash13(cell + 5.0));
      col += sc * star * tw * uNight * 3.0 * smoothstep(-0.02, 0.2, dir.y);
    }
    vec3 axis = normalize(vec3(0.3, 0.55, 0.78));
    float band = exp(-pow(dot(dir, axis) * 5.0, 2.0));
    float mw = fbm(dir.xz * 9.0 + dir.y * 4.0);
    col += vec3(0.28, 0.3, 0.45) * band * mw * mw * 0.35 * uNight * smoothstep(0.0, 0.3, dir.y);
  }

  // \u592A\u9633\u5706\u76D8
  float sd = dot(dir, uSunDir);
  col += uSunColor * smoothstep(0.99955, 0.99975, sd) * 18.0 * (1.0 - uNight);

  // \u6708\u4EAE\uFF08\u5E26\u7B80\u5355\u6708\u76F8\u660E\u6697\uFF09
  float md = dot(dir, uMoonDir);
  float moon = smoothstep(0.99925, 0.99945, md);
  if (moon > 0.0) {
    vec3 t1 = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    vec3 t2 = cross(t1, uMoonDir);
    vec2 mp = vec2(dot(dir, t1), dot(dir, t2)) / 0.033;
    float lit = smoothstep(-0.25, 0.35, mp.x + 0.35);
    float craters = 0.82 + 0.18 * vnoise(mp * 6.0);
    col = mix(col, vec3(1.0, 0.97, 0.9) * 2.4 * craters * mix(0.12, 1.0, lit), moon * smoothstep(0.0, 0.5, uNight));
  }

  // \u7A0B\u5E8F\u5316\u4E91\u5C42
  if (dir.y > 0.0) {
    vec2 uv = dir.xz / (dir.y + 0.1) * 0.55 + uCloudOffset;
    float n = fbm(uv * 0.9);
    float n2 = fbm(uv * 2.3 + 4.0);
    float d = n * 0.75 + n2 * 0.35;
    float cover = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.32, d);
    float lightN = fbm(uv * 0.9 - uSunDir.xz * 0.12);
    float lit = clamp(0.55 + (n - lightN) * 3.0, 0.0, 1.0);
    float sunSide = pow(max(dot(dir, uSunDir), 0.0), 3.0);
    vec3 cc = mix(uCloudShade, uCloudTint, lit) + uSunColor * sunSide * 0.5 * (1.0 - uNight);
    float horizonFade = smoothstep(0.0, 0.14, dir.y);
    col = mix(col, cc, cover * horizonFade * 0.92);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;function yx(){let i={...wn,uDetail:{value:1}},e=new Lt({uniforms:i,vertexShader:_2,fragmentShader:M2,side:gn,depthWrite:!1}),t=new mn(400,48,24),n=new at(t,e);n.frustumCulled=!1,n.renderOrder=-10;let r=new at(new mn(50,32,16),e);return{mesh:n,envMesh:r,material:e}}var Nr=i=>new be(i),ld=[{e:-24,zen:"#02030a",hor:"#070a18",gnd:"#030409",sun:"#000000",li:0,hs:"#1f2c58",hg:"#07070c",hi:.42,fog:"#080c1a",exp:1.5,ct:"#161b2c",cs:"#070912",bloom:.95},{e:-9,zen:"#081028",hor:"#23264a",gnd:"#0b0c16",sun:"#ff5a3a",li:0,hs:"#2a3564",hg:"#0c0c14",hi:.45,fog:"#161a33",exp:1.4,ct:"#2d2a48",cs:"#0f1024",bloom:.85},{e:-2,zen:"#1c2a5e",hor:"#d0694a",gnd:"#2b1d20",sun:"#ff5b2a",li:.25,hs:"#50507a",hg:"#2b1c1c",hi:.45,fog:"#6a4a5a",exp:1.18,ct:"#f07a5a",cs:"#3a2a4a",bloom:.7},{e:3,zen:"#2f4f9a",hor:"#ff9658",gnd:"#5a3a2c",sun:"#ff8a3c",li:1.3,hs:"#8a86b0",hg:"#4a3326",hi:.55,fog:"#d58a6a",exp:1,ct:"#ffb487",cs:"#6a5070",bloom:.55},{e:10,zen:"#3a6fc0",hor:"#ffc896",gnd:"#6e5a48",sun:"#ffc27e",li:2.3,hs:"#a9c2e6",hg:"#6b5a40",hi:.65,fog:"#e8c2a2",exp:.95,ct:"#fff0dc",cs:"#9aa2b8",bloom:.42},{e:28,zen:"#2f76d2",hor:"#b9dbf4",gnd:"#7a7058",sun:"#fff0d6",li:3,hs:"#b8d8ff",hg:"#6f6448",hi:.8,fog:"#bcd6ea",exp:.9,ct:"#ffffff",cs:"#b4c2d6",bloom:.32},{e:75,zen:"#256bd4",hor:"#c6e3fb",gnd:"#7c7460",sun:"#ffffff",li:3.3,hs:"#c0dcff",hg:"#6f6448",hi:.85,fog:"#c4dcf0",exp:.88,ct:"#ffffff",cs:"#bcc8da",bloom:.3}].map(i=>({...i,zen:Nr(i.zen),hor:Nr(i.hor),gnd:Nr(i.gnd),sun:Nr(i.sun),hs:Nr(i.hs),hg:Nr(i.hg),fog:Nr(i.fog),ct:Nr(i.ct),cs:Nr(i.cs)})),S2=["zen","hor","gnd","sun","hs","hg","fog","ct","cs"],b2=["li","hi","exp","bloom"];function _x(i,e){let t=0;for(;t<ld.length-2&&i>ld[t+1].e;)t++;let n=ld[t],r=ld[t+1],s=Sn((i-n.e)/(r.e-n.e),0,1);for(let o of S2)e[o]||(e[o]=new be),e[o].copy(n[o]).lerp(r[o],s);for(let o of b2)e[o]=bn(n[o],r[o],s);return e}function Mx(i,e){let t=(i-6)/12,n=(i-18+24)%24/12,r=i>=6&&i<=18?Math.sin(t*Math.PI)*(66*Math.PI/180):-Math.sin(n*Math.PI)*.9,s=(120-t*180)*Math.PI/180;return e.set(Math.cos(r)*Math.cos(s),Math.sin(r),Math.cos(r)*Math.sin(s)),e}function Sx(i,e){let t=(i-18+24)%24/12,n=Math.sin(Sn(t,0,1)*Math.PI)*.95-.12,r=(-110+t*150)*Math.PI/180;return e.set(Math.cos(n)*Math.cos(r),Math.sin(n),Math.cos(n)*Math.sin(r)).normalize(),e}var bx=i=>Ht(-1.5,-11,i);var Ua=-1.6,Xm=-14.6,vu=[[.18,1,.2,21,1],[-.45,1,.17,12.5,1],[.75,.62,.13,7,1],[-.9,.45,.1,4.2,1],[.3,1,.07,2.6,1]],w2=`
uniform float uTime;
uniform float uOffset;
uniform float uAmp;
uniform float uPhase[${vu.length}];
varying vec3 vWorld;
varying vec3 vNormal;
varying float vHeight;
varying vec2 vWP;

const float SHORE = ${Xm.toFixed(2)};
// \u76F8\u4F4D = k\xB7(d.x\xB7\u884C\u9A76\u8DDD\u79BB) - k\xB7c\xB7t \u5728 JS \u4E2D\u4EE5\u53CC\u7CBE\u5EA6\u53D6\u6A21\u540E\u4F20\u5165\uFF0C\u907F\u514D\u957F\u8DDD\u79BB\u540E\u6D6E\u70B9\u8DF3\u53D8
vec3 gerstner(vec2 p, vec2 dir, float steep, float wl, float phase, float amp, inout vec3 tangent, inout vec3 binormal) {
  float k = 6.28318 / wl;
  vec2 d = normalize(dir);
  float f = k * dot(d, p) + phase;
  float st = steep * amp;
  float a = st / k;
  float sf = sin(f);
  float cf = cos(f);
  tangent += vec3(-d.x * d.x * st * sf, d.x * st * cf, -d.x * d.y * st * sf);
  binormal += vec3(-d.x * d.y * st * sf, d.y * st * cf, -d.y * d.y * st * sf);
  return vec3(d.x * a * cf, a * sf, d.y * a * cf);
}

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 p = vec2(wp.x, wp.z);
  float off = smoothstep(SHORE + 1.0, SHORE - 30.0, wp.z);
  float amp = uAmp * mix(0.35, 1.0, off);
  vec3 tangent = vec3(1.0, 0.0, 0.0);
  vec3 binormal = vec3(0.0, 0.0, 1.0);
  vec3 disp = vec3(0.0);
  ${vu.map((i,e)=>`disp += gerstner(p, vec2(${i[0].toFixed(3)}, ${i[1].toFixed(3)}), ${i[2].toFixed(3)}, ${i[3].toFixed(3)}, uPhase[${e}], amp, tangent, binormal);`).join(`
  `)}
  wp.xyz += disp;
  vNormal = normalize(cross(binormal, tangent));
  vWorld = wp.xyz;
  vHeight = disp.y / max(uAmp, 0.05);
  vWP = vec2(wp.x + uOffset, wp.z);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`,T2=`
${Wm}
${xx}
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uFogDensity;
uniform float uDayLight;
uniform float uOffset;
uniform vec3 uLampColor;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vHeight;
varying vec2 vWP;
const float SHORE = ${Xm.toFixed(2)};

void main() {
  vec3 N = normalize(vNormal);
  float dist = length(vWorld - cameraPosition);
  // \u7EC6\u8282\u6CD5\u7EBF\uFF1A\u4E24\u5C42\u6EDA\u52A8\u566A\u58F0\u7684\u6709\u9650\u5DEE\u5206
  vec2 q = vWP * 0.55;
  float e = 0.35;
  vec2 f1 = vec2(0.35, 0.6) * uTime;
  vec2 f2 = vec2(-0.5, 0.25) * uTime;
  float h0 = vnoise(q + f1) + 0.5 * vnoise(q * 2.7 + f2);
  float hx = vnoise(q + vec2(e, 0.0) + f1) + 0.5 * vnoise((q + vec2(e, 0.0)) * 2.7 + f2);
  float hz = vnoise(q + vec2(0.0, e) + f1) + 0.5 * vnoise((q + vec2(0.0, e)) * 2.7 + f2);
  float detail = 0.55 * (1.0 - smoothstep(20.0, 160.0, dist));
  N = normalize(N + vec3(h0 - hx, 0.0, h0 - hz) * detail);

  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(clamp(1.0 - ndv, 0.0, 1.0), 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) + 0.02;
  R = normalize(R);
  vec3 refl = skyBase(R);

  float depthF = smoothstep(SHORE - 2.0, SHORE - 45.0, vWorld.z);
  vec3 water = mix(uShallow, uDeep, depthF) * (0.12 + 0.88 * uDayLight);
  // \u6D6A\u5C16\u900F\u5149
  float sss = pow(max(dot(V, -uSunDir), 0.0), 3.0) * clamp(vHeight + 0.3, 0.0, 1.5);
  water += uShallow * uSunColor * sss * 0.35 * (1.0 - uNight);

  vec3 col = mix(water, refl, fres);
  float rs = max(dot(R, uSunDir), 0.0);
  col += uSunColor * (pow(rs, 420.0) * 30.0 + pow(rs, 60.0) * 0.7) * (1.0 - uNight) * step(-0.05, uSunDir.y);
  float rm = max(dot(R, uMoonDir), 0.0);
  col += vec3(0.75, 0.82, 1.0) * (pow(rm, 250.0) * 2.2 + pow(rm, 30.0) * 0.06) * uNight;

  // \u6D6A\u5C16\u767D\u6CAB + \u5CB8\u8FB9\u788E\u6D6A
  float fn = vnoise(vWP * 1.3 + uTime * 0.4) * 0.6 + vnoise(vWP * 4.0 - uTime * 0.3) * 0.4;
  float crest = smoothstep(0.62, 1.05, vHeight + fn * 0.35) * smoothstep(-8.0, -40.0, vWorld.z);
  float shoreLine = SHORE + 0.9 * sin(vWP.x * 0.045) + 0.5 * sin(vWP.x * 0.13 + 1.7);
  float surge = sin(uTime * 0.7 + vWP.x * 0.021) * 1.3;
  float sd = vWorld.z - (shoreLine + surge * 0.5);
  float shoreFoam = smoothstep(-5.5, 0.5, sd) * (0.55 + 0.45 * fn);
  shoreFoam *= smoothstep(0.35, 0.55, fn + smoothstep(-2.5, 0.8, sd) * 0.5);
  float foam = clamp(max(crest * 0.75, shoreFoam), 0.0, 1.0);
  vec3 foamCol = mix(vec3(0.06, 0.08, 0.12), vec3(0.95, 0.97, 1.0), uDayLight) * (0.6 + 0.4 * uSunGlow);
  col = mix(col, foamCol, foam * 0.85);

  // \u8DEF\u706F\u5012\u5F71\uFF08\u591C\u95F4\u6696\u8272\u5149\u5E26\uFF09
  float lampRow = pow(max(0.0, 1.0 - abs(fract((vWP.x - 12.0) / 36.0 + 0.5) - 0.5) * 7.0), 2.0);
  col += uLampColor * lampRow * smoothstep(-40.0, -14.0, vWorld.z) * uNight * 0.25 * (0.5 + 0.5 * fn);

  // \u5927\u6C14\u96FE -> \u4E0E\u5929\u7A7A\u5730\u5E73\u7EBF\u989C\u8272\u878D\u5408
  float fogF = 1.0 - exp(-pow(dist * uFogDensity, 1.35));
  vec3 fd = vWorld - cameraPosition;
  vec3 fogCol = skyBase(normalize(vec3(fd.x, max(fd.y * 0.02, 0.0) + 0.004, fd.z)));
  col = mix(col, fogCol, clamp(fogF, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}
`;function wx(){let i={...wn,uOffset:{value:0},uAmp:{value:1},uPhase:{value:new Float32Array(vu.length)},uDeep:{value:new be("#0b3a5a")},uShallow:{value:new be("#1fa3a8")},uFogDensity:{value:.0042},uDayLight:{value:1},uLampColor:{value:new be("#ffb46a")}},e=new Lt({uniforms:i,vertexShader:w2,fragmentShader:T2}),t=[];for(let c=-260;c<=420;c+=c>-60&&c<120?1.2:4)t.push(c);let n=[];for(let c=-8;c>=-520;c-=c>-70?.9:c>-160?2.5:8)n.push(c);let r=[],s=[];for(let c=0;c<n.length;c++)for(let u=0;u<t.length;u++)r.push(t[u],0,n[c]);let o=t.length;for(let c=0;c<n.length-1;c++)for(let u=0;u<o-1;u++){let f=c*o+u,h=f+o;s.push(f,f+1,h,h,f+1,h+1)}let a=new et;a.setAttribute("position",new Ve(r,3)),a.setIndex(s);let l=new at(a,e);return l.position.y=Ua,l.frustumCulled=!1,l.name="ocean",{mesh:l,uniforms:i,columns:t.length,rows:n.length}}function Tx(i,e,t){return vu.forEach((n,r)=>{let s=2*Math.PI/n[3],o=Math.sqrt(9.8/s)*n[4],a=n[0]/Math.hypot(n[0],n[1]),l=(s*a*i-s*o*e)%(2*Math.PI);t[r]=l}),t}function cd(i,e,t,n=1){let r=Math.min(1,Math.max(0,(Xm+1-e)/31)),s=n*(.35+.65*r*r*(3-2*r)),o=0;for(let a of vu){let l=2*Math.PI/a[3],c=Math.sqrt(9.8/l)*a[4],u=Math.hypot(a[0],a[1]),f=a[0]/u,h=a[1]/u,d=l*(f*i+h*e-c*t);o+=a[2]*s/l*Math.sin(d)}return Ua+o}var{lerp:io}=$f,Dn=[151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,133,230,220,105,92,41,55,46,245,40,244,102,143,54,65,25,63,161,1,216,80,73,209,76,132,187,208,89,18,169,200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,52,217,226,250,124,123,5,202,38,147,118,126,255,82,85,212,207,206,59,227,47,16,58,17,182,189,28,42,223,183,170,213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,172,9,129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,218,246,97,228,251,34,242,193,238,210,144,12,191,179,162,241,81,51,145,235,249,14,239,107,49,192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,127,4,150,254,138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180];for(let i=0;i<256;i++)Dn[256+i]=Dn[i];function qm(i){return i*i*i*(i*(i*6-15)+10)}function as(i,e,t,n){let r=i&15,s=r<8?e:t,o=r<4?t:r==12||r==14?e:n;return((r&1)==0?s:-s)+((r&2)==0?o:-o)}var ud=class{noise(e,t,n){let r=Math.floor(e),s=Math.floor(t),o=Math.floor(n),a=r&255,l=s&255,c=o&255;e-=r,t-=s,n-=o;let u=e-1,f=t-1,h=n-1,d=qm(e),p=qm(t),v=qm(n),g=Dn[a]+l,m=Dn[g]+c,y=Dn[g+1]+c,_=Dn[a+1]+l,x=Dn[_]+c,S=Dn[_+1]+c;return io(io(io(as(Dn[m],e,t,n),as(Dn[x],u,t,n),d),io(as(Dn[y],e,f,n),as(Dn[S],u,f,n),d),p),io(io(as(Dn[m+1],e,t,h),as(Dn[x+1],u,t,h),d),io(as(Dn[y+1],e,f,h),as(Dn[S+1],u,f,h),d),p),v)}};function Vi(i,e=!1){let t=i[0].index!==null,n=new Set(Object.keys(i[0].attributes)),r=new Set(Object.keys(i[0].morphAttributes)),s={},o={},a=i[0].morphTargetsRelative,l=new et,c=0;for(let u=0;u<i.length;++u){let f=i[u],h=0;if(t!==(f.index!==null))return console.error("THREE.BufferGeometryUtils: .mergeGeometries() failed with geometry at index "+u+". All geometries must have compatible attributes; make sure index attribute exists among all geometries, or in none of them."),null;for(let d in f.attributes){if(!n.has(d))return console.error("THREE.BufferGeometryUtils: .mergeGeometries() failed with geometry at index "+u+'. All geometries must have compatible attributes; make sure "'+d+'" attribute exists among all geometries, or in none of them.'),null;s[d]===void 0&&(s[d]=[]),s[d].push(f.attributes[d]),h++}if(h!==n.size)return console.error("THREE.BufferGeometryUtils: .mergeGeometries() failed with geometry at index "+u+". Make sure all geometries have the same number of attributes."),null;if(a!==f.morphTargetsRelative)return console.error("THREE.BufferGeometryUtils: .mergeGeometries() failed with geometry at index "+u+". .morphTargetsRelative must be consistent throughout all geometries."),null;for(let d in f.morphAttributes){if(!r.has(d))return console.error("THREE.BufferGeometryUtils: .mergeGeometries() failed with geometry at index "+u+".  .morphAttributes must be consistent throughout all geometries."),null;o[d]===void 0&&(o[d]=[]),o[d].push(f.morphAttributes[d])}if(e){let d;if(t)d=f.index.count;else if(f.attributes.position!==void 0)d=f.attributes.position.count;else return console.error("THREE.BufferGeometryUtils: .mergeGeometries() failed with geometry at index "+u+". The geometry must have either an index or a position attribute"),null;l.addGroup(c,d,u),c+=d}}if(t){let u=0,f=[];for(let h=0;h<i.length;++h){let d=i[h].index;for(let p=0;p<d.count;++p)f.push(d.getX(p)+u);u+=i[h].attributes.position.count}l.setIndex(f)}for(let u in s){let f=Ax(s[u]);if(!f)return console.error("THREE.BufferGeometryUtils: .mergeGeometries() failed while trying to merge the "+u+" attribute."),null;l.setAttribute(u,f)}for(let u in o){let f=o[u][0].length;if(f!==0){l.morphAttributes=l.morphAttributes||{},l.morphAttributes[u]=[];for(let h=0;h<f;++h){let d=[];for(let v=0;v<o[u].length;++v)d.push(o[u][v][h]);let p=Ax(d);if(!p)return console.error("THREE.BufferGeometryUtils: .mergeGeometries() failed while trying to merge the "+u+" morphAttribute."),null;l.morphAttributes[u].push(p)}}}return l}function Ax(i){let e,t,n,r=-1,s=0;for(let c=0;c<i.length;++c){let u=i[c];if(e===void 0&&(e=u.array.constructor),e!==u.array.constructor)return console.error("THREE.BufferGeometryUtils: .mergeAttributes() failed. BufferAttribute.array must be of consistent array types across matching attributes."),null;if(t===void 0&&(t=u.itemSize),t!==u.itemSize)return console.error("THREE.BufferGeometryUtils: .mergeAttributes() failed. BufferAttribute.itemSize must be consistent across matching attributes."),null;if(n===void 0&&(n=u.normalized),n!==u.normalized)return console.error("THREE.BufferGeometryUtils: .mergeAttributes() failed. BufferAttribute.normalized must be consistent across matching attributes."),null;if(r===-1&&(r=u.gpuType),r!==u.gpuType)return console.error("THREE.BufferGeometryUtils: .mergeAttributes() failed. BufferAttribute.gpuType must be consistent across matching attributes."),null;s+=u.count*t}let o=new e(s),a=new ht(o,t,n),l=0;for(let c=0;c<i.length;++c){let u=i[c];if(u.isInterleavedBufferAttribute){let f=l/t;for(let h=0,d=u.count;h<d;h++)for(let p=0;p<t;p++){let v=u.getComponent(h,p);a.setComponent(h+f,p,v)}}else o.set(u.array,l);l+=u.count*t}return r!==void 0&&(a.gpuType=r),a}function Ba(i,e){let t=document.createElement("canvas");return t.width=i,t.height=e,[t,t.getContext("2d")]}function Oa(i,{srgb:e=!0,repeat:t=!0,aniso:n=8}={}){let r=new Zo(i);return e&&(r.colorSpace=nn),t&&(r.wrapS=r.wrapT=Yr),r.anisotropy=n,r.needsUpdate=!0,r}function A2(i,e,t){let n=no(t),r=new Float32Array(i*i),s=1,o=0;for(let a=0;a<e;a++){let l=4<<a,c=new Float32Array(l*l);for(let u=0;u<c.length;u++)c[u]=n();for(let u=0;u<i;u++){let f=u/i*l,h=Math.floor(f),d=f-h,p=d*d*(3-2*d);for(let v=0;v<i;v++){let g=v/i*l,m=Math.floor(g),y=g-m,_=y*y*(3-2*y),x=c[h%l*l+m%l],S=c[h%l*l+(m+1)%l],b=c[(h+1)%l*l+m%l],E=c[(h+1)%l*l+(m+1)%l];r[u*i+v]+=s*((x*(1-_)+S*_)*(1-p)+(b*(1-_)+E*_)*p)}}o+=s,s*=.5}for(let a=0;a<r.length;a++)r[a]/=o;return r}function Cx(i=256,e=.78,t=1,n=7){let[r,s]=Ba(i,i),o=A2(i,6,n),a=s.createImageData(i,i);for(let l=0;l<o.length;l++){let c=Math.round((e+(t-e)*o[l])*255);a.data[l*4]=c,a.data[l*4+1]=c,a.data[l*4+2]=c,a.data[l*4+3]=255}return s.putImageData(a,0,0),Oa(r,{srgb:!1})}function Rx(){let[t,n]=Ba(2048,512),[r,s]=Ba(2048,512),o=no(42);n.fillStyle="#44464b",n.fillRect(0,0,2048,512),s.fillStyle="#808080",s.fillRect(0,0,2048,512);for(let p=0;p<9e4;p++){let v=o()*2048,g=o()*512,m=o()*2.2+.6,y=Math.floor(40+o()*70);n.fillStyle=`rgb(${y},${y+1},${y+4})`,n.fillRect(v,g,m,m);let _=Math.floor(90+o()*120);s.fillStyle=`rgb(${_},${_},${_})`,s.fillRect(v,g,m,m)}for(let p=0;p<6;p++){n.fillStyle=`rgba(20,20,24,${.12+o()*.12})`;let v=o()*2048,g=o()*512;n.fillRect(v,g,60+o()*160,30+o()*90)}let a=n.createLinearGradient(0,0,0,512);a.addColorStop(0,"rgba(0,0,0,0)"),a.addColorStop(.3,"rgba(0,0,0,0.10)"),a.addColorStop(.36,"rgba(0,0,0,0)"),a.addColorStop(.64,"rgba(0,0,0,0)"),a.addColorStop(.7,"rgba(0,0,0,0.10)"),a.addColorStop(1,"rgba(0,0,0,0)"),n.fillStyle=a,n.fillRect(0,0,2048,512);let l=2048/24,c=512/5.4,u=(p,v,g,m,y="#ecebe2")=>{n.fillStyle=y,n.fillRect(p*l,v*c,g*l,m*c),s.fillStyle="#c8c8c8",s.fillRect(p*l,v*c,g*l,m*c)};u(0,.18,24,.12),u(0,5.1,24,.12);for(let p=0;p<24;p+=6)u(p,2.64,3,.12,"#f2c94c");n.save(),n.translate(12*l,4*c),n.rotate(Math.PI/2),n.scale(c,l),n.strokeStyle="rgba(236,235,226,0.92)",n.fillStyle="rgba(236,235,226,0.92)",n.lineWidth=.09,n.lineCap="round",n.lineJoin="round";let f=.42;n.beginPath(),n.arc(-.62,.35,f,0,Math.PI*2),n.stroke(),n.beginPath(),n.arc(.62,.35,f,0,Math.PI*2),n.stroke(),n.beginPath(),n.moveTo(-.62,.35),n.lineTo(-.1,.35),n.lineTo(.35,-.2),n.lineTo(-.3,-.2),n.closePath(),n.moveTo(-.1,.35),n.lineTo(-.36,-.42),n.moveTo(.62,.35),n.lineTo(.42,-.5),n.lineTo(.6,-.55),n.moveTo(-.5,-.45),n.lineTo(-.2,-.45),n.stroke(),n.beginPath(),n.moveTo(0,-2.9),n.lineTo(.45,-2.3),n.lineTo(.16,-2.3),n.lineTo(.16,-1.6),n.lineTo(-.16,-1.6),n.lineTo(-.16,-2.3),n.lineTo(-.45,-2.3),n.closePath(),n.fill(),n.restore();let h=Oa(t,{aniso:16}),d=Oa(r,{srgb:!1,aniso:16});return{map:h,bump:d}}function Px(){let[e,t]=Ba(128,128),n=t.createRadialGradient(128/2,128/2,0,128/2,128/2,128/2);return n.addColorStop(0,"rgba(255,255,255,1)"),n.addColorStop(.25,"rgba(255,255,255,0.8)"),n.addColorStop(1,"rgba(255,255,255,0)"),t.fillStyle=n,t.fillRect(0,0,128,128),Oa(e,{repeat:!1})}function E2(i,e,t,n){i.save(),i.translate(e,t),i.scale(n,n),i.fillStyle="#161616",i.strokeStyle="#161616",i.lineWidth=.09,i.lineCap="round",i.lineJoin="round",i.beginPath(),i.arc(-.6,.52,.35,0,Math.PI*2),i.stroke(),i.beginPath(),i.arc(.63,.52,.35,0,Math.PI*2),i.stroke(),i.beginPath(),i.moveTo(-.6,.52),i.lineTo(.02,.52),i.lineTo(-.2,0),i.moveTo(-.2,0),i.lineTo(.46,.02),i.moveTo(.46,.02),i.lineTo(.02,.52),i.moveTo(.46,.02),i.lineTo(.63,.52),i.moveTo(-.6,.52),i.lineTo(-.2,0),i.stroke(),i.beginPath(),i.moveTo(.46,.02),i.lineTo(.58,-.12),i.moveTo(-.34,-.08),i.lineTo(-.1,-.08),i.stroke(),i.beginPath(),i.moveTo(-.2,-.12),i.lineTo(.22,-.64),i.moveTo(.22,-.64),i.lineTo(.4,-.38),i.lineTo(.55,-.12),i.moveTo(-.2,-.12),i.lineTo(.2,.22),i.lineTo(.18,.68),i.moveTo(-.2,-.12),i.lineTo(-.3,.24),i.lineTo(-.14,.36),i.stroke(),i.beginPath(),i.arc(.32,-.79,.13,0,Math.PI*2),i.fill(),i.restore()}function Ix(i){let[t,n]=Ba(512,512);return n.clearRect(0,0,512,512),i==="crossing"?(n.save(),n.translate(512/2,512/2),n.rotate(Math.PI/4),n.fillStyle="#161616",n.fillRect(-172,-172,344,344),n.fillStyle="#f7c531",n.fillRect(-160,-160,320,320),n.restore(),E2(n,512/2,512/2-6,112)):i==="speed"?(n.fillStyle="#ffffff",n.beginPath(),n.arc(512/2,512/2,230,0,Math.PI*2),n.fill(),n.lineWidth=42,n.strokeStyle="#d7263d",n.beginPath(),n.arc(512/2,512/2,200,0,Math.PI*2),n.stroke(),n.fillStyle="#111",n.font='900 190px "Arial Black", Arial, sans-serif',n.textAlign="center",n.textBaseline="middle",n.fillText("45",512/2,512/2-18),n.font='700 46px "PingFang SC", "Microsoft YaHei", sans-serif',n.fillText("\u9A91\u884C\u9650\u901F",512/2,512/2+110)):(n.fillStyle="#0f5fa8",Ex(n,20,110,472,292,34),n.fill(),n.lineWidth=12,n.strokeStyle="#ffffff",Ex(n,36,126,440,260,24),n.stroke(),n.fillStyle="#fff",n.font='800 76px "PingFang SC", "Microsoft YaHei", sans-serif',n.textAlign="center",n.textBaseline="middle",n.fillText("\u524D\u65B9\u6D77\u5CB8",512/2,512/2-40),n.font='700 44px "Arial", sans-serif',n.fillText("COAST AHEAD  \u279C",512/2,512/2+56)),Oa(t,{repeat:!1})}function Ex(i,e,t,n,r,s){i.beginPath(),i.moveTo(e+s,t),i.arcTo(e+n,t,e+n,t+r,s),i.arcTo(e+n,t+r,e,t+r,s),i.arcTo(e,t+r,e,t,s),i.arcTo(e,t,e+n,t,s),i.closePath()}function Lx(i,e=8,t=!1){let[n,r]=Ba(256,256);for(let s=0;s<e;s++)r.fillStyle=i[s%i.length],t?r.fillRect(s*256/e,0,256/e+1,256):r.fillRect(0,s*256/e,256,256/e+1);return Oa(n)}var Qt=72,xu=7,Dx=new ud;function yu(i,e,t,n=0){let r=0,s=.5,o=1;for(let a=0;a<t;a++)r+=s*Dx.noise(i*o,e*o,n+a*7.31),s*=.5,o*=2.03;return r}function ar(i,e){if(e>=0){let s=Ht(3.8,28,e),o=2.5+17*Ht(16,115,e),a=yu(i*.013,e*.013,4,1.3),l=yu(i*.085,e*.085,2,5.1);return-.06+s*Math.max(0,o*(.62+1.1*a)+l*1.3)}let t=-e,n=Ht(3.2,30,t),r=yu(i*.07,e*.07,2,9.7)*.5*Ht(3.6,6.5,t)*(1-Ht(9,13.5,t));return-.08-n*3.9+r}function C2(i,e,t){let r=ar(i-.6,e)-ar(i+.6,e),s=ar(i,e-.6)-ar(i,e+.6);return t.set(r,2*.6,s).normalize()}var mi=i=>new be(i),Fr={grassA:mi("#5d8a34"),grassB:mi("#93b453"),grassDry:mi("#b8b064"),rock:mi("#8c867c"),dirt:mi("#9a8866"),sand:mi("#ead7a6"),sandWet:mi("#b89f74"),sandDeep:mi("#7d6c52"),gravel:mi("#8f877a")};function R2(i,e,t,n,r){if(e>=0){let s=yu(i*.05,e*.05,3,3.3)+.5;r.copy(Fr.grassA).lerp(Fr.grassB,Sn(s,0,1)),r.lerp(Fr.grassDry,Ht(9,22,t)*.55),r.lerp(Fr.dirt,1-Ht(3.6,6.5,e)),r.lerp(Fr.rock,Ht(.86,.7,n.y))}else{let s=-e;r.copy(Fr.gravel).lerp(Fr.sand,Ht(3.2,4.2,s)),r.lerp(Fr.sandWet,Ht(-1.1,-1.55,t)),r.lerp(Fr.sandDeep,Ht(-1.7,-2.6,t));let o=yu(i*.3,e*.3,2,2.2)*.12;r.offsetHSL(0,0,o)}return r}function P2(){let i=[];for(let e=-34;e<-16;e+=2)i.push(e);for(let e=-16;e<-3.4;e+=.7)i.push(e);i.push(-3.3,-2.9,2.9,3.4,3.8);for(let e=4.6;e<22;e+=1.2)i.push(e);for(let e=22;e<60;e+=2.4)i.push(e);for(let e=60;e<=136;e+=4)i.push(e);return i}function I2(){let i=[];for(let o=0;o<=Qt;o+=2)i.push(o);let e=P2(),t=i.length*e.length,n=new et;n.setAttribute("position",new ht(new Float32Array(t*3),3)),n.setAttribute("normal",new ht(new Float32Array(t*3),3)),n.setAttribute("color",new ht(new Float32Array(t*3),3)),n.setAttribute("uv",new ht(new Float32Array(t*2),2));let r=[],s=i.length;for(let o=0;o<e.length-1;o++)for(let a=0;a<s-1;a++){let l=o*s+a,c=l+s;r.push(l,c,l+1,c,c+1,l+1)}return n.setIndex(r),n.userData={xs:i,zs:e},Ym(n,i.length,e.length),n}function Ym(i,e,t){let n=Array.from(i.index.array),r={high:{start:0,count:n.length}},s=n[1]===n[0]+1;for(let[o,a]of[["medium",2],["low",3]]){let l=n.length;for(let c=0;c<t-1;c+=a)for(let u=0;u<e-1;u+=a){let f=c*e+u,h=Math.min(t-1,c+a)*e+u,d=Math.min(e-1,u+a)-u;s?n.push(f,f+d,h,h,f+d,h+d):n.push(f,h,f+d,h,h+d,f+d)}r[o]={start:l,count:n.length-l}}i.setIndex(n),i.userData.lodRanges=r,i.setDrawRange(0,r.high.count)}var ro=new R,hd=new be;function L2(i,e){let{xs:t,zs:n}=i.userData,r=t.length,s=n.length,o=r+2,a=i.userData.hbuf||(i.userData.hbuf=new Float32Array(o*s)),l=t[1]-t[0];for(let p=0;p<s;p++)for(let v=-1;v<=r;v++)a[p*o+v+1]=ar(e+v*l,n[p]);let c=i.attributes.position.array,u=i.attributes.normal.array,f=i.attributes.color.array,h=i.attributes.uv.array,d=0;for(let p=0;p<s;p++){let v=Math.max(0,p-1),g=Math.min(s-1,p+1),m=n[g]-n[v];for(let y=0;y<r;y++){let _=t[y],x=n[p],S=e+_,b=a[p*o+y+1],E=(a[p*o+y+2]-a[p*o+y])/(2*l),M=(a[g*o+y+1]-a[v*o+y+1])/m;ro.set(-E,1,-M).normalize(),R2(S,x,b,ro,hd),c[d*3]=_,c[d*3+1]=b,c[d*3+2]=x,u[d*3]=ro.x,u[d*3+1]=ro.y,u[d*3+2]=ro.z,f[d*3]=hd.r,f[d*3+1]=hd.g,f[d*3+2]=hd.b,h[d*2]=S/9,h[d*2+1]=x/9,d++}}i.attributes.position.needsUpdate=!0,i.attributes.normal.needsUpdate=!0,i.attributes.color.needsUpdate=!0,i.attributes.uv.needsUpdate=!0,i.computeBoundingSphere()}function _u(i,e,t){let n=no(t),r=i.attributes.position,s=new Map;for(let o=0;o<r.count;o++){let a=`${r.getX(o).toFixed(3)},${r.getY(o).toFixed(3)},${r.getZ(o).toFixed(3)}`,l=s.get(a);l||(l=[(n()-.5)*e,(n()-.5)*e,(n()-.5)*e],s.set(a,l)),r.setXYZ(o,r.getX(o)+l[0],r.getY(o)+l[1],r.getZ(o)+l[2])}return i.computeVertexNormals(),i}function D2(){let e=[Nt(Et(new pn(.12,.2,1.8,7).translate(0,.9,0)),"#6e4a2e")];return[[0,2.35,0,1.25],[.62,2,.3,.85],[-.5,2.1,-.35,.9],[.1,2.95,.1,.8]].forEach(([n,r,s,o],a)=>{let l=_u(new Os(o,1),o*.22,11+a);l.translate(n,r,s),e.push(Nt(Et(l),a%2?"#4f7f2c":"#5f9134"))}),Vi(e)}function N2(){let i=[Nt(Et(new pn(.1,.16,1.2,6).translate(0,.6,0)),"#5a3b24")];return[[1,1.35,1.7],[1.75,1.05,1.5],[2.45,.75,1.3],[3.05,.45,1]].forEach(([t,n,r],s)=>{let o=_u(new Qn(n,r,8,1),.08,30+s);o.translate(0,t+r/2,0),i.push(Nt(Et(o),s%2?"#2f5d34":"#386b3a"))}),Vi(i)}function F2(){let i=[],e=new gu(18,8,s=>bn(.2,.12,s)*(1+.12*Math.max(0,Math.sin(s*60)))),t=pi(1.1,5.6,.2);e.update([pi(0,0,0),pi(.15,1.8,0),pi(.55,3.8,.1),t]);let n=e.geometry.clone();i.push(Nt(Et(n),"#8a6a45"));let r=9;for(let s=0;s<r;s++){let o=s/r*or+s%2*.2,a=2.3+s%3*.35,l=s%2?.55:.25,c=Hm({segs:14,ring:4,center:u=>pi(u*a,Math.sin(u*Math.PI*.75)*l-u*u*1.35,0),section:(u,f)=>{let h=Math.sin(Math.PI*Math.pow(u,.7))*.38+.02,d=f*2-1;return[-Math.abs(d)*h*.35+.01,d*h]}});c.rotateY(o),c.translate(t.x,t.y,t.z),i.push(Nt(Et(c),s%2?"#3f7d2e":"#4f9136"))}for(let s=0;s<4;s++){let o=new mn(.14,8,6),a=s/4*or;o.translate(t.x+Math.cos(a)*.18,t.y-.18,t.z+Math.sin(a)*.18),i.push(Nt(Et(o),"#5b3d1f"))}return Vi(i)}function U2(){let i=_u(new Ns(.8,1),.35,77);return i.scale(1.2,.7,1),Nt(Et(i),"#9a938a")}function B2(){let i=[];i.push(Nt(Et(new pn(.03,.03,2.2,6).translate(0,1.1,0)),"#dddddd"));let e=new Qn(1.25,.45,12,1,!0).toNonIndexed();e.translate(0,2.2,0);let t=e.attributes.position,n=new Float32Array(t.count*3),r=mi("#ffffff"),s=mi("#e0413b");for(let a=0;a<t.count;a+=3){let l=(t.getX(a)+t.getX(a+1)+t.getX(a+2))/3,c=(t.getZ(a)+t.getZ(a+1)+t.getZ(a+2))/3,f=Math.floor((Math.atan2(c,l)+Math.PI)/or*12)%2?r:s;for(let h=0;h<3;h++)n.set([f.r,f.g,f.b],(a+h)*3)}e.setAttribute("color",new ht(n,3)),e.computeVertexNormals(),i.push(Et(e));let o=new In(1.8,.02,.9).translate(.4,.02,1);return i.push(Nt(Et(o),"#f5f0e0")),Vi(i)}function O2(){let i=[];for(let e=0;e<Qt;e+=2.4)i.push(Nt(Et(new In(.08,.8,.08).translate(e+1.2,.4,-3.05)),"#f0f0ec"));return i.push(Nt(Et(new In(Qt,.07,.04).translate(Qt/2,.74,-3)),"#d9dcdf")),i.push(Nt(Et(new In(Qt,.05,.04).translate(Qt/2,.42,-3)),"#d9dcdf")),i.push(Nt(Et(new In(Qt,.1,.25).translate(Qt/2,.02,-2.82)),"#bdb8ae")),i.push(Nt(Et(new In(Qt,.16,1).translate(Qt/2,.06,3.3)),"#c9c3b8")),i.push(Nt(Et(new In(Qt,.18,.12).translate(Qt/2,.07,2.82)),"#e6e1d6")),Vi(i)}var Zm=[12,48];function z2(){let i=[];for(let e of Zm){i.push(Et(new pn(.06,.1,5.2,10).translate(e,2.66,3.45)));let t=new gu(12,6,()=>.045);t.update([pi(e,5.1,3.45),pi(e,5.55,3.2),pi(e,5.6,2.55),pi(e,5.45,2)]),i.push(Et(t.geometry.clone())),i.push(Et(new pn(.12,.26,.2,12).translate(e,5.36,1.95))),i.push(Et(new pn(.16,.16,.06,10).translate(e,.17,3.45)))}return Nt(Vi(i),"#3a4046")}function k2(){let i=[];for(let e of Zm){let t=new mn(.17,16,8,0,or,Math.PI/2,Math.PI/2);t.scale(1,.5,1).translate(e,5.27,1.95),i.push(Et(t))}return Vi(i)}function G2(){let i=[];for(let e of Zm){let t=new Ds(3.4,32);t.rotateX(-Math.PI/2),t.scale(1.25,1,1),t.translate(e,.03,1.3),i.push(t)}return Vi(i)}function V2(){return Nt(Et(new pn(.04,.04,2.3,8).translate(0,1.15,0)),"#9aa0a6")}function Nx(i,e){let t=new kn;i.add(t);let n={value:0},r=Cx(256,.8,1,3);r.repeat.set(1,1);let s=new Dt({vertexColors:!0,map:r,roughness:.95,metalness:0}),o=Rx();o.map.repeat.set(Qt/24,1),o.bump.repeat.set(Qt/24,1);let a=new Dt({map:o.map,bumpMap:o.bump,bumpScale:1.2,roughness:.82,metalness:.02}),l=new ji(Qt,5.64);l.rotateX(-Math.PI/2),l.translate(Qt/2,.005,0);let c=new Dt({vertexColors:!0,roughness:.7,metalness:.1}),u=new Dt({vertexColors:!0,roughness:.45,metalness:.6}),f=new Dt({color:"#fff4dc",emissive:new be("#ffc27a"),emissiveIntensity:0}),h=Px(),d=new Hn({map:h,color:new be("#ffb467"),transparent:!0,opacity:0,blending:Cr,depthWrite:!1}),p=(G,re,Q)=>{G.onBeforeCompile=V=>{V.uniforms.uTime=n,V.vertexShader=V.vertexShader.replace("#include <common>",`#include <common>
uniform float uTime;`).replace("#include <begin_vertex>",`#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 ip = instanceMatrix[3].xyz;
            float sw = pow(max(position.y - ${Q.toFixed(1)}, 0.0), 1.4);
            transformed.x += sin(uTime * 1.3 + ip.x * 0.31 + ip.z * 0.17) * sw * ${re.toFixed(3)};
            transformed.z += cos(uTime * 1.1 + ip.x * 0.23) * sw * ${(re*.6).toFixed(3)};
          #endif`)}},v=new Dt({vertexColors:!0,roughness:.9,flatShading:!0});p(v,.018,1.4);let g=new Dt({vertexColors:!0,roughness:.8,side:vn});p(g,.03,3);let m=new Dt({vertexColors:!0,roughness:.95,flatShading:!0}),y=new Dt({vertexColors:!0,roughness:.7,side:vn}),_={round:D2(),pine:N2(),palm:F2(),rock:U2(),umb:B2(),guard:O2(),lamp:z2(),bulb:k2(),pool:G2(),signPost:V2()},x=["crossing","speed","fish"].map(G=>new Dt({map:Ix(G),transparent:!0,alphaTest:.4,roughness:.5,side:vn})),S=new ji(1.1,1.1);S.rotateY(-Math.PI/2);let b=e.density??1,E=1,M="high",T={round:Math.round(34*b),pine:Math.round(26*b),palm:6,rock:8,umb:2},A=[];for(let G=0;G<xu;G++){let re=new kn,Q=I2(),V=new at(Q,s);V.receiveShadow=!0,V.name="terrain";let ee=new at(l,a);ee.receiveShadow=!0;let le=new at(_.guard,c);le.castShadow=!0,le.receiveShadow=!0;let Se=new at(_.lamp,u);Se.castShadow=!0;let me=new at(_.bulb,f),_e=new at(_.pool,d);_e.renderOrder=2,re.add(V,ee,le,Se,me,_e);let ce={},fe=(se,Pe,Be=!0)=>{let ue=new Ji(_[se],Pe,T[se]);ue.castShadow=Be,ue.receiveShadow=!0,ue.instanceMatrix.setUsage(js),ue.instanceColor=new wi(new Float32Array(T[se]*3),3),re.add(ue),ce[se]=ue};fe("round",v),fe("pine",v),fe("palm",g),fe("rock",m),fe("umb",y);let De=new kn,O=new at(_.signPost,c);O.castShadow=!0;let Me=new at(S,x[0]);Me.position.set(-.03,2.05,0),Me.castShadow=!0,De.add(O,Me),De.position.set(30,.14,3.55),re.add(De),t.add(re),A.push({index:-99,group:re,terrain:V,inst:ce,sign:De,plate:Me})}let I=new it,D=new Jt,B=new R,F=new R,L=new Vn,U=new be;function X(G,re){G.index=re;let Q=re*Qt;L2(G.terrain.geometry,Q);let V=no(re*9973+17),ee=(ce,fe,De,O,Me,se,Pe)=>{let Be=G.inst[ce],ue=0;for(let je=0;je<fe*4&&ue<fe;je++){let Ze=V()*Qt,Mt=bn(De,O,Math.pow(V(),ce==="round"||ce==="pine"?1.6:1)),ct=Q+Ze,Vt=ar(ct,Mt);if(C2(ct,Mt,ro),Pe&&!Pe(Ze,Mt,Vt,ro))continue;let kt=bn(Me,se,V());L.set(0,V()*or,0),D.setFromEuler(L),B.set(kt,kt*bn(.85,1.2,V()),kt),F.set(Ze,Vt-.05,Mt),I.compose(F,D,B),Be.setMatrixAt(ue,I),U.setHSL(bn(-.03,.05,V()),bn(0,.25,V()),bn(.85,1.1,V())),Be.setColorAt(ue,U),ue++}Be.userData.population=ue,Be.count=Math.floor(ue*E),Be.instanceMatrix.needsUpdate=!0,Be.instanceColor&&(Be.instanceColor.needsUpdate=!0),Be.computeBoundingSphere()},le=(ce,fe,De,O)=>O.y>.8;ee("round",T.round,7,125,.8,1.6,(ce,fe,De,O)=>le(ce,fe,De,O)&&Dx.noise((Q+ce)*.03,fe*.03,4.2)>-.15),ee("pine",T.pine,16,130,.9,1.7,(ce,fe,De,O)=>O.y>.75&&De>4),ee("palm",T.palm,-5.2,-11.5,.8,1.1,ce=>Math.abs(ce-30)>2),ee("rock",T.rock,-30,60,.3,1.1,(ce,fe)=>Math.abs(fe)>4.5&&(fe<-12||fe>5)),ee("umb",V()<.7?2:0,-7,-11,.9,1.05);let Se=G.inst.palm;for(let ce=0;ce<Se.count;ce++){Se.getMatrixAt(ce,I),I.decompose(F,D,B);let fe=(V()-.5)*.3;L.set(0,Math.PI/2+.3+fe,0),D.setFromEuler(L),I.compose(F,D,B),Se.setMatrixAt(ce,I)}Se.instanceMatrix.needsUpdate=!0;let me=G.inst.umb;for(let ce=0;ce<me.count;ce++)U.setHSL(V(),.7,.62),me.setColorAt(ce,U);me.instanceColor&&(me.instanceColor.needsUpdate=!0);let _e=re%2===1;G.sign.visible=_e,_e&&(G.plate.material=x[Math.abs(Math.floor(re/2))%x.length])}let te=new kn;{let G=_u(new Qn(16,7,14,3),1.6,5);G.translate(0,1.2,0);let re=new at(G,new Dt({color:"#6f6a5f",roughness:1,flatShading:!0}));re.receiveShadow=!0;let Q=new at(_u(new mn(7,12,6,0,or,0,Math.PI/2.4),.8,8).scale(1,.35,1).translate(0,4.2,0),new Dt({color:"#6f8f3a",roughness:1,flatShading:!0})),V=Lx(["#f4f1ea","#c9302c"],6),ee=new at(new pn(1.1,1.7,13,24,1),new Dt({map:V,roughness:.6}));ee.position.y=11,ee.castShadow=!0;let le=new at(new pn(1.7,1.7,.25,24),new Dt({color:"#2b2f33"}));le.position.y=17.6;let Se=new at(new pn(.9,.9,1.6,16),new Dt({color:"#fff6d8",emissive:new be("#ffd27a"),emissiveIntensity:.4,roughness:.2}));Se.position.y=18.5;let me=new at(new Qn(1.25,1.4,16),new Dt({color:"#b3261e",roughness:.5}));me.position.y=20,te.add(re,Q,ee,le,Se,me),te.userData={lantern:Se},te.position.set(0,Ua-.5,-118),i.add(te)}let Z=[];{let G=Hm({segs:16,ring:12,center:Se=>pi((Se-.5)*6,0,0),section:(Se,me)=>{let _e=me*or,ce=Math.pow(Math.sin(Math.PI*Math.pow(Se,.8)),.6)*1.1+.02,fe=Math.cos(_e);return[fe>0?fe*.5:fe*.9,Math.sin(_e)*ce]},color:(Se,me,_e)=>_e.set(Math.cos(me*or)>.2?"#f4f4f0":"#1f4f7a")}),re=new Ti;re.moveTo(0,0),re.lineTo(0,7),re.quadraticCurveTo(1.6,3.5,3.4,.2),re.closePath();let Q=new wr(re,8),V=new Ti;V.moveTo(0,0),V.lineTo(0,6.2),V.lineTo(-2.4,.2),V.closePath();let ee=new wr(V),le=["#ffffff","#ffd166","#ef476f","#ffffff","#8ecae6"];for(let Se=0;Se<5;Se++){let me=new kn,_e=new at(G,new Dt({vertexColors:!0,roughness:.4})),ce=new at(new pn(.06,.08,8,6),new Dt({color:"#dcdcdc"}));ce.position.set(.3,4.2,0);let fe=new Dt({color:le[Se],side:vn,roughness:.8}),De=new at(Q,fe);De.position.set(.3,.9,0),De.rotation.y=Math.PI;let O=new at(ee,new Dt({color:"#f7f7f2",side:vn}));O.position.set(.5,.9,0),O.rotation.y=Math.PI,me.add(_e,ce,De,O);let Me=.9+Se*.12;me.scale.setScalar(Me),me.userData={ax:60+Se*170,z:-42-Se*34,period:900,phase:Se*1.3,drift:.6+Se*.25},i.add(me),Z.push(me)}}function K(G,{body:re,wing:Q,wingMat:V,bodyMat:ee,shoulder:le}){let Se=new Ji(re,ee,G),me=new Ji(Q,V,G),_e=new Ji(Q,V,G);for(let ce of[Se,me,_e])ce.frustumCulled=!1,ce.castShadow=!1,i.add(ce);return{bodies:Se,wl:me,wr:_e,count:G,shoulder:le}}let j=Vi([Nt(Et(new mn(1,12,8).scale(.24,.075,.08)),"#fbfbfb"),Nt(Et(new mn(.06,10,8).translate(.22,.03,0)),"#ffffff"),Nt(Et(new Qn(.018,.08,6).rotateZ(-Math.PI/2).translate(.3,.025,0)),"#f2c230"),Nt(Et(new Qn(.06,.16,6).rotateZ(Math.PI/2).translate(-.28,0,0).scale(1,.4,1)),"#e8e8e8")]),ne=(G,re,Q,V,ee)=>{let le=new Ti;le.moveTo(0,re*.2),le.quadraticCurveTo(G*.5,re*.35,G,-re*.05),le.lineTo(G*.8,-re*.45),le.quadraticCurveTo(G*.4,-re*.9,0,-re*.8),le.closePath();let Se=new wr(le,6);Se.rotateX(-Math.PI/2);let me=Se.attributes.position,_e=new Float32Array(me.count*3),ce=mi(Q),fe=mi(V);for(let De=0;De<me.count;De++){let Me=me.getX(De)/G>ee?ce:fe;_e.set([Me.r,Me.g,Me.b],De*3)}return Se.setAttribute("color",new ht(_e,3)),Se.rotateY(-Math.PI/2),Se},ie=new Dt({vertexColors:!0,side:vn,roughness:.8}),We=new Dt({vertexColors:!0,roughness:.7}),Fe=K(9,{body:j,wing:ne(.55,.16,"#222222","#b9c0c7",.72),wingMat:ie,bodyMat:We,shoulder:.02});Fe.params=[];for(let G=0;G<Fe.count;G++)Fe.params.push({cx:(G-4)*7,cy:7+G%3*2.5,cz:-12-G%4*7,rx:9+G,rz:4+G%3*2,w:.12+G*.013,ph:G*1.7,flap:5.5+G%3,s:.9+G%3*.15});let Ye=Vi([Nt(Et(new mn(1,14,10).scale(.5,.16,.17)),"#f6f3ec"),Nt(Et(new mn(.11,10,8).translate(.44,.06,0)),"#f6f3ec"),Nt(Et(new Qn(.045,.55,8).rotateZ(-Math.PI/2).scale(1,1,.7).translate(.8,.02,0)),"#f2b24a"),Nt(Et(new mn(.05,8,6).scale(4,1,1).translate(.72,-.05,0)),"#f6c85f")]),$=K(3,{body:Ye,wing:ne(1.3,.38,"#161616","#f4f1ea",.55),wingMat:ie,bodyMat:We,shoulder:0}),oe=new it,Ce=new it,He=new it,Ee=new Jt,ze=new Jt,pt=new R,ae=new R,xe=new Vn;function we(G,re,Q,V,ee,le,Se){xe.set(ee,V,0,"YXZ"),Ee.setFromEuler(xe),pt.setScalar(Se),oe.compose(Q,Ee,pt),G.bodies.setMatrixAt(re,oe),ze.setFromAxisAngle(Ae,-le),He.compose(ae.set(.02,.03,.05),ze,Te),Ce.multiplyMatrices(oe,He),G.wr.setMatrixAt(re,Ce),ze.setFromAxisAngle(Ae,Math.PI+le),He.compose(ae.set(.02,.03,-.05),ze,Te),Ce.multiplyMatrices(oe,He),G.wl.setMatrixAt(re,Ce)}let Ae=new R(1,0,0),Te=new R(1,1,1),de=new R,Oe=160,Re=new et,Je=new Float32Array(Oe*3),z=new Float32Array(Oe),lt=no(5);for(let G=0;G<Oe;G++)Je[G*3]=lt()*200-60,Je[G*3+1]=.4+lt()*2.6,Je[G*3+2]=4.5+lt()*22,z[G]=lt()*100;Re.setAttribute("position",new ht(Je,3)),Re.setAttribute("aSeed",new ht(z,1));let rt=new Lt({transparent:!0,depthWrite:!1,blending:Cr,uniforms:{uTime:n,uNight:{value:0},uOffset:{value:0},uScale:{value:400}},vertexShader:`attribute float aSeed; uniform float uTime; uniform float uOffset; uniform float uScale; varying float vA;
      void main(){ vec3 p = position; p.x = mod(p.x - uOffset + 60.0, 200.0) - 60.0;
        p.x += sin(uTime*0.7 + aSeed)*0.6; p.y += sin(uTime*0.9 + aSeed*1.3)*0.35; p.z += cos(uTime*0.6 + aSeed*0.7)*0.6;
        vec4 mv = modelViewMatrix*vec4(p,1.0); gl_Position = projectionMatrix*mv;
        vA = pow(0.5 + 0.5*sin(uTime*2.2 + aSeed*3.0), 3.0);
        gl_PointSize = 0.12 * uScale / -mv.z; }`,fragmentShader:`uniform float uNight; varying float vA;
      void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vec3(0.75,1.0,0.35)*2.5, a*vA*uNight); }`}),P=new Is(Re,rt);P.frustumCulled=!1,i.add(P);function w(G,re,Q,V){n.value=Q;let ee=Math.floor(G/Qt)-3;for(let ce=0;ce<xu;ce++){let fe=ee+ce,De=(fe%xu+xu)%xu,O=A[De];if(O.index!==fe&&X(O,fe),O.group.position.x=fe*Qt-G,M==="low"){let Me=Math.abs(fe-Math.floor(G/Qt));O.group.visible=Me<=2,O.group.children.forEach((se,Pe)=>{se.visible=Me===0||Pe===0||Me===1&&Pe===1})}else{O.group.visible=!0;let Me=Math.abs(fe-Math.floor(G/Qt));O.group.children.forEach((se,Pe)=>{se.visible=M==="high"||Me<=1||Pe<=2})}}let le=V.night;f.emissiveIntensity=bn(0,6,Ht(.15,.6,le)),d.opacity=Ht(.2,.7,le)*.5;let Se=1600;te.position.x=((330-G+420)%Se+Se)%Se-420;let me=te.userData;me.lantern.material.emissiveIntensity=bn(.4,8,Ht(.2,.7,le));for(let ce of Z){let fe=ce.userData,De=fe.ax+Q*fe.drift;ce.position.x=((De-G+300)%fe.period+fe.period)%fe.period-300;let O=ce.position.x+G,Me=cd(O,fe.z,Q,V.waveAmp),se=cd(O+2.5,fe.z,Q,V.waveAmp),Pe=cd(O,fe.z+1.2,Q,V.waveAmp);ce.position.y=Me+.15,ce.position.z=fe.z,ce.rotation.z=Math.atan2(se-Me,2.5)*.8,ce.rotation.x=-Math.atan2(Pe-Me,1.2)*.8+Math.sin(Q*.8+fe.phase)*.04}for(let ce=0;ce<Fe.count;ce++){let fe=Fe.params[ce],De=Q*fe.w+fe.ph;de.set(fe.cx+Math.sin(De)*fe.rx+6,fe.cy+Math.sin(De*2.3)*1.2,fe.cz+Math.cos(De)*fe.rz);let O=Math.cos(De)*fe.rx,Me=-Math.sin(De)*fe.rz,se=Math.atan2(-Me,O),Be=Math.sin(Q*.5+fe.ph)>.2?.12+Math.sin(Q*1.5+ce)*.05:Math.sin(Q*fe.flap+fe.ph)*.6;we(Fe,ce,de,se,-Math.sin(De)*.35,Be,fe.s)}for(let ce of[Fe.bodies,Fe.wl,Fe.wr])ce.instanceMatrix.needsUpdate=!0;let _e=Q*3.2%560-260;for(let ce=0;ce<3;ce++){let fe=ce===0?0:2.6,De=ce===1?-1:1;de.set(_e-fe,5.5+Math.sin(Q*.6+ce)*.35+(ce?.4:0),-22+(ce?De*2.4:0));let O=Math.sin(Q*2.4-ce*.6)*.38*(Math.sin(Q*.25)>-.3?1:.15);we($,ce,de,0,Math.sin(Q*.4+ce)*.06,O,1)}for(let ce of[$.bodies,$.wl,$.wr])ce.instanceMatrix.needsUpdate=!0;rt.uniforms.uNight.value=Ht(.35,.9,le),rt.uniforms.uOffset.value=G%200}function q(G,re){let V=Math.floor((G-12)/36)*36+12;return re[0].set(V-G,5.2,1.95),re[1].set(V+36-G,5.2,1.95),re}function J(G,re="high"){E=Sn(G,.1,1),M=re;for(let Q of A){let V=Q.terrain.geometry.userData.lodRanges[re]||Q.terrain.geometry.userData.lodRanges.high;Q.terrain.geometry.setDrawRange(V.start,V.count);for(let ee of Object.values(Q.inst))ee.count=Math.floor((ee.userData.population??ee.count)*E),ee.computeBoundingSphere()}for(let Q of[Fe,$])for(let V of[Q.bodies,Q.wl,Q.wr])V.count=Math.max(1,Math.floor(Q.count*E));[$.bodies,$.wl,$.wr].forEach(Q=>{Q.visible=re==="high"}),Z.forEach((Q,V)=>{Q.visible=re==="high"||re==="medium"&&V<3||V===0}),Re.setDrawRange(0,Math.floor(Oe*E))}return{group:t,update:w,lampPositions:q,ffMat:rt,terrainHeight:ar,chunks:A,setDensity:J}}var fd={low:{prCap:1,prMul:.8,shadow:0,bloom:!1,msaa:0,density:.5},medium:{prCap:1.25,prMul:1,shadow:1024,bloom:!0,msaa:2,density:.8},high:{prCap:1.75,prMul:1,shadow:2048,bloom:!0,msaa:4,density:1}},H2=typeof window<"u"&&window.devicePixelRatio?window.devicePixelRatio:1,W2=-13,Fx=i=>(18+12.2*Sn(i,0,1))%24,X2={uniforms:{tDiffuse:{value:null}},vertexShader:"varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }",fragmentShader:`uniform sampler2D tDiffuse; varying vec2 vUv;
    float fixf(float x) {
      uint b = floatBitsToUint(x);
      if ((b & 0x7f800000u) == 0x7f800000u) return ((b & 0x007fffffu) == 0u && (b & 0x80000000u) == 0u) ? 48.0 : 0.0;
      return clamp(x, 0.0, 48.0);
    }
    void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; gl_FragColor = vec4(fixf(c.r), fixf(c.g), fixf(c.b), 1.0); }`};function q2(i){i.traverse(e=>{e.geometry&&e.geometry.dispose();let t=Array.isArray(e.material)?e.material:e.material?[e.material]:[];for(let n of t){for(let r of Object.keys(n)){let s=n[r];s&&s.isTexture&&s.dispose()}n.dispose()}})}function Y2(i,e,t=null){let n=fd[e.quality]||fd.high,r=t&&t.renderer;try{r||(r=new Lr({canvas:i,antialias:!1,powerPreference:"high-performance"}))}catch{return null}let s=Math.min(H2,n.prCap)*n.prMul;t||r.setPixelRatio(s),r.shadowMap.enabled=!t&&n.shadow>0,r.shadowMap.type=ns,r.toneMapping=rs,r.toneMappingExposure=1;let o=t?t.scene:new li;o.fog=new Ps(16777215,.0052);let a=t?t.camera:new Ft(44,1,.05,900);Object.assign(a,{fov:44,near:.05,far:900});let l=a.clone();o.add(a);let c=yx();t&&(t.scope.trackTree(c.mesh),t.scope.trackTree(c.envMesh)),o.add(c.mesh);let u=new to(r);t&&t.scope.track(u);let f=new li;f.add(c.envMesh);let h=null,d=-99;function p(){let de=u.fromScene(f,0,.1,100);h&&(t?t.scope.release(h):h.dispose()),h=de,t&&t.scope.track(de),o.environment=de.texture}let v=new Gs(16777215,4473924,.6);o.add(v);let g=new Ws(16777215,3);if(n.shadow>0){g.castShadow=!0,g.shadow.mapSize.set(n.shadow,n.shadow);let de=7.5;Object.assign(g.shadow.camera,{left:-de,right:de,top:de,bottom:-de,near:1,far:80}),g.shadow.bias=-3e-4,g.shadow.normalBias=.025,g.shadow.radius=2.5}o.add(g,g.target);let m=[new Ar("#ffc27a",0,14,1.6),new Ar("#ffc27a",0,14,1.6)];m.forEach(de=>o.add(de));let y=[new R,new R],_=new Ar("#b9c8ff",0,10,1.2);_.position.set(.6,.8,.5),a.add(_);let x=wx();t&&Ym(x.mesh.geometry,x.columns,x.rows),t&&t.scope.trackTree(x.mesh),o.add(x.mesh);let S=Nx(o,{density:t?1:n.density}),b=r.getDrawingBufferSize(new he),E=t?null:new Gt(b.x,b.y,{type:ln,samples:n.msaa}),M=t?null:new sd(r,E),T=t?{enabled:!1}:new Fa(new he(2,2),.4,.55,.92);M&&(M.setPixelRatio(s),M.addPass(new od(o,a)),M.addPass(new Na(X2)),T.enabled=n.bloom,M.addPass(T),M.addPass(new ad)),t&&(t.scope.trackTree(o),t.scope.trackTree(f));let A={t:0,distance:0,speed:0,lane:.9,laneV:0,laneTarget:.9,tod:0,hour:Fx(e.tod||0),reduced:!!e.reduced,interactive:e.interactive!==!1},I={night:0,waveAmp:1},D={target:0,level:0,slow:0,bass:0,onset:!1},B=0,F=1.05,L=new R(-4.4,1.8,2.4),U={yaw0:Math.atan2(L.x,L.z),pitch0:Math.asin(L.y/L.length()),dist0:L.length(),yaw:0,pitch:0,dist:0,lastInput:-99,dragging:!1,control:null};U.yaw=U.yaw0,U.pitch=U.pitch0,U.dist=U.dist0;let X=new R,te=new R,Z=new R;function K(){A.interactive&&(U.dragging=!0,U.lastInput=A.t)}function j(de){!A.interactive||!U.dragging||!(de.buttons&1)||(U.yaw=Sn(U.yaw-de.movementX*.005,U.yaw0-2.6,U.yaw0+2.6),U.pitch=Sn(U.pitch+de.movementY*.004,.08,1.25),U.lastInput=A.t)}function ne(){U.dragging=!1}function ie(de){A.interactive&&(de.preventDefault(),U.dist=Sn(U.dist*(1+de.deltaY*.001),2.4,15),U.lastInput=A.t)}function We(){A.interactive&&(U.yaw=U.yaw0,U.pitch=U.pitch0,U.dist=U.dist0,U.lastInput=A.t)}function Fe(de){let Oe=de.x+A.distance;return Math.abs(de.z)<2.9?.02:de.z<W2?Math.max(Ua+.4,ar(Oe,de.z)):ar(Oe,de.z)}function Ye(de){if(U.control){let Re=U.control;if(Re.position)l.position.fromArray(Re.position);else{let z=Math.cos(Re.pitch);l.position.set(Re.tx+Math.sin(Re.yaw)*z*Re.dist,Re.ty+Math.sin(Re.pitch)*Re.dist,Re.tz+Math.cos(Re.yaw)*z*Re.dist)}l.position.y=Math.max(l.position.y,Fe(l.position)+.3),Re.position?l.rotation.set(Re.pitch,Re.yaw,Re.roll,"YXZ"):(l.lookAt(Re.tx,Re.ty,Re.tz),l.rotateZ(Re.roll||0));let Je=Re.external?1:1-Math.exp(-de/.26);a.position.lerp(l.position,Je),a.position.y=Math.max(a.position.y,Fe(a.position)+.3),a.quaternion.slerp(l.quaternion,Je),a.fov+=(Re.fov-a.fov)*Je,a.updateProjectionMatrix();return}X.set(0,F,A.lane),A.t-U.lastInput>4&&(U.yaw=os(U.yaw,U.yaw0,1.2,de),U.pitch=os(U.pitch,U.pitch0,1.2,de),U.dist=os(U.dist,U.dist0,1.2,de));let Oe=Math.cos(U.pitch);Z.set(X.x+Math.sin(U.yaw)*Oe*U.dist,X.y+Math.sin(U.pitch)*U.dist,X.z+Math.cos(U.yaw)*Oe*U.dist),Z.y=Math.max(Z.y,Fe(Z)+.3),te.set(2.2,.55,A.lane*.4),a.position.copy(Z),a.lookAt(te),a.fov=44,a.updateProjectionMatrix()}let $={},oe=new R,Ce=new R;function He(){let de=A.hour;Mx(de,oe),Sx(de,Ce);let Oe=Math.asin(Sn(oe.y,-1,1))*180/Math.PI;_x(Oe,$);let Re=bx(Oe);I.night=Re,wn.uSunDir.value.copy(oe),wn.uMoonDir.value.copy(Ce),wn.uZenith.value.copy($.zen),wn.uHorizon.value.copy($.hor),wn.uGround.value.copy($.gnd),wn.uSunColor.value.copy($.sun),wn.uSunGlow.value=1-Re*.9,wn.uNight.value=Re,wn.uTime.value=A.t,wn.uCloudCover.value=.42,wn.uCloudTint.value.copy($.ct),wn.uCloudShade.value.copy($.cs),wn.uCloudOffset.value.set(A.distance*9e-4+A.t*.004,A.t*.0015);let Je=Oe<-4,z=Je?Ce:oe;g.position.set(0,0,A.lane).addScaledVector(z,40),g.target.position.set(0,0,A.lane),Je?(g.color.set("#9fb6ff"),g.intensity=.8*Ht(-4,-12,Oe)*Sn(Ce.y*3,0,1)):(g.color.copy($.sun),g.intensity=$.li),v.color.copy($.hs),v.groundColor.copy($.hg),v.intensity=$.hi,o.fog.color.copy($.fog),o.fog.density=.0052,x.uniforms.uFogDensity.value=.0036,x.uniforms.uDayLight.value=Sn($.li/3+$.hi*.25,.08,1),x.uniforms.uOffset.value=A.distance%36e3,Tx(A.distance,A.t,x.uniforms.uPhase.value),x.uniforms.uAmp.value=I.waveAmp,r.toneMappingExposure=$.exp*(1+.1*Ht(.4,.9,D.slow)),o.environmentIntensity=bn(1,.22,Re),n.bloom&&(T.strength=$.bloom*(1+.9*B)*bn(1,.7,Re),T.threshold=bn(1.05,.88,Re)),_.intensity=Re*2.2,(Math.abs(de-d)>.18||d<0)&&(d=de,p()),S.lampPositions(A.distance,y),m.forEach((lt,rt)=>{lt.position.copy(y[rt]),lt.intensity=Ht(.25,.75,Re)*18})}let Ee=0,ze=0,pt=new he;function ae(de){Ee=requestAnimationFrame(ae);let Oe=ze?Math.min((de-ze)/1e3,.05):0;ze=de,xe(Oe),Oe&&M.render()}function xe(de){if(!de&&!t)return;A.t+=de,D.level=os(D.level,D.target,3.2,de),D.slow=os(D.slow,D.level,.9,de),D.onset?B=1:B=os(B,0,2.2,de),D.onset=!1;let Oe=A.reduced?3.2:6.8,Re=.6+.8*Ht(.05,.7,D.level);A.speed=os(A.speed,Oe*(A.reduced?.45:Re),.9,de),A.distance+=A.speed*de,A.laneTarget=.9+Math.sin(A.t*.23)*.7;let Je=10;A.laneV+=((A.laneTarget-A.lane)*Je-A.laneV*2*Math.sqrt(Je))*de,A.lane+=A.laneV*de,I.waveAmp=A.reduced?.35:.55+.9*Ht(.1,.75,D.bass),S.update(A.distance,de,A.t,I),He(),Ye(de),c.mesh.position.copy(a.position),r.getDrawingBufferSize(pt),S.ffMat.uniforms.uScale.value=pt.y/(2*Math.tan(a.fov*Math.PI/360))}function we(de,Oe){let Re=Math.max(2,de|0),Je=Math.max(2,Oe|0);a.aspect=Re/Je,a.updateProjectionMatrix(),t||r.setSize(Re,Je,!1),M&&M.setSize(Re,Je),T.resolution&&T.resolution.set(Re/2,Je/2)}function Ae(){i.addEventListener("pointerdown",K),i.addEventListener("pointermove",j),window.addEventListener("pointerup",ne),i.addEventListener("wheel",ie,{passive:!1}),i.addEventListener("dblclick",We),i.style.touchAction=A.interactive?"none":""}function Te(){i.removeEventListener("pointerdown",K),i.removeEventListener("pointermove",j),window.removeEventListener("pointerup",ne),i.removeEventListener("wheel",ie),i.removeEventListener("dblclick",We),i.style.touchAction=""}return{canvas:i,renderer:r,composer:M,quality:n,scene:o,camera:a,S:A,env:I,audio:D,rig:U,resize:we,update:xe,setQuality(de){n=fd[de.mode]||fd.medium,S.setDensity(de.density,de.mode);let Oe=x.mesh.geometry.userData.lodRanges[de.mode];x.mesh.geometry.setDrawRange(Oe.start,Oe.count)},start(){ze=0,Ee=requestAnimationFrame(ae)},stop(){cancelAnimationFrame(Ee),Ee=0,ze=0},renderOnce(){S.update(A.distance,.016,A.t,I),He(),Ye(.016),c.mesh.position.copy(a.position),M&&M.render()},bind:Ae,unbind:Te,dispose(){t||(q2(o),u.dispose(),h&&h.dispose(),M.dispose(),E.dispose(),r.dispose(),r.forceContextLoss&&r.forceContextLoss())}}}function Ux(i){let e=Y2(i.renderer.domElement,{quality:i.quality.mode,tod:i.params.tod,interactive:!1},i);if(!e)throw new Error("Coast world initialization failed");let t=!1,n=!!i.params.reduced;return{update(r){e.S.reduced=n||!!r.reduced,e.audio.target=Sn(r.level||0,0,1);let s=r.bands||[],o=0,a=Math.min(8,s.length);for(let c=0;c<a;c++)o+=s[c]||0;e.audio.bass=a?Sn(o/a*1.4,0,1):0,e.audio.onset=!e.S.reduced&&!!r.onset;let l=e.S.reduced||r.playing===!1?0:r.dynamicDt??r.dt??.016;e.update(Math.max(0,Math.min(l,.1)))},resize:e.resize,setParams(r){e.S.tod=r.tod,e.S.hour=Fx(r.tod),n=!!r.reduced,e.S.reduced=n},setQuality:e.setQuality,setRig(r){e.rig.control=r},dispose(){t||(t=!0)}}}var qn=(i,e=0,t=1)=>i<e?e:i>t?t:i;function Z2(i){let e=2166136261,t=String(i??"");for(let n=0;n<t.length;n+=1)e^=t.charCodeAt(n),e=Math.imul(e,16777619);return e>>>0}function Nn(i){let e=(typeof i=="number"?i:Z2(i))>>>0;return()=>{e=e+1831565813>>>0;let t=e;return t=Math.imul(t^t>>>15,t|1),t^=t+Math.imul(t^t>>>7,t|61),((t^t>>>14)>>>0)/4294967296}}function $m(i,e,t){let n=t||new Float32Array(e),r=i&&i.length?i:null;if(!r)return n.fill(0,0,e),n;let s=r.length;for(let o=0;o<e;o+=1){let a=Math.floor(Math.pow(s+1,o/e)-1),l=Math.min(s,Math.max(a+1,Math.ceil(Math.pow(s+1,(o+1)/e)-1))),c=0,u=0;for(let h=a;h<l;h+=1){let d=qn(Number(r[h])||0);d>c&&(c=d),u+=d*d}let f=.6*c+.4*Math.sqrt(u/(l-a));n[o]=qn(Math.pow(Math.max(0,f-.008),.6)*1.65)}return n}function Bx(i,e,t){let n=i;for(let r=0;r<n.length&&r<e.length;r+=1){let s=e[r]>n[r];n[r]=za(n[r],e[r],s?1/24:1/6,t)}return n}function za(i,e,t,n){return t>0?i+(e-i)*(1-Math.exp(-Math.max(0,n)/t)):e}function jm(i,e,t=2){let n=e&&e.length,r=n?e[0]*t:i.length,s=zx(i,0,r,t,!0),o=[];if(!s||s.next===s.prev)return o;let a,l,c;if(n&&(s=Q2(i,e,s,t)),i.length>80*t){a=i[0],l=i[1];let u=a,f=l;for(let h=t;h<r;h+=t){let d=i[h],p=i[h+1];d<a&&(a=d),p<l&&(l=p),d>u&&(u=d),p>f&&(f=p)}c=Math.max(u-a,f-l),c=c!==0?32767/c:0}return Su(s,o,t,a,l,c,0),o}function zx(i,e,t,n,r){let s;if(r===uT(i,e,t,n)>0)for(let o=e;o<t;o+=n)s=Ox(o/n|0,i[o],i[o+1],s);else for(let o=t-n;o>=e;o-=n)s=Ox(o/n|0,i[o],i[o+1],s);return s&&ka(s,s.next)&&(wu(s),s=s.next),s}function so(i,e){if(!i)return i;e||(e=i);let t=i,n;do if(n=!1,!t.steiner&&(ka(t,t.next)||Zt(t.prev,t,t.next)===0)){if(wu(t),t=e=t.prev,t===t.next)break;n=!0}else t=t.next;while(n||t!==e);return e}function Su(i,e,t,n,r,s,o){if(!i)return;!o&&s&&rT(i,n,r,s);let a=i;for(;i.prev!==i.next;){let l=i.prev,c=i.next;if(s?J2(i,n,r,s):$2(i)){e.push(l.i,i.i,c.i),wu(i),i=c.next,a=c.next;continue}if(i=c,i===a){o?o===1?(i=K2(so(i),e),Su(i,e,t,n,r,s,2)):o===2&&j2(i,e,t,n,r,s):Su(so(i),e,t,n,r,s,1);break}}}function $2(i){let e=i.prev,t=i,n=i.next;if(Zt(e,t,n)>=0)return!1;let r=e.x,s=t.x,o=n.x,a=e.y,l=t.y,c=n.y,u=Math.min(r,s,o),f=Math.min(a,l,c),h=Math.max(r,s,o),d=Math.max(a,l,c),p=n.next;for(;p!==e;){if(p.x>=u&&p.x<=h&&p.y>=f&&p.y<=d&&Mu(r,a,s,l,o,c,p.x,p.y)&&Zt(p.prev,p,p.next)>=0)return!1;p=p.next}return!0}function J2(i,e,t,n){let r=i.prev,s=i,o=i.next;if(Zt(r,s,o)>=0)return!1;let a=r.x,l=s.x,c=o.x,u=r.y,f=s.y,h=o.y,d=Math.min(a,l,c),p=Math.min(u,f,h),v=Math.max(a,l,c),g=Math.max(u,f,h),m=Jm(d,p,e,t,n),y=Jm(v,g,e,t,n),_=i.prevZ,x=i.nextZ;for(;_&&_.z>=m&&x&&x.z<=y;){if(_.x>=d&&_.x<=v&&_.y>=p&&_.y<=g&&_!==r&&_!==o&&Mu(a,u,l,f,c,h,_.x,_.y)&&Zt(_.prev,_,_.next)>=0||(_=_.prevZ,x.x>=d&&x.x<=v&&x.y>=p&&x.y<=g&&x!==r&&x!==o&&Mu(a,u,l,f,c,h,x.x,x.y)&&Zt(x.prev,x,x.next)>=0))return!1;x=x.nextZ}for(;_&&_.z>=m;){if(_.x>=d&&_.x<=v&&_.y>=p&&_.y<=g&&_!==r&&_!==o&&Mu(a,u,l,f,c,h,_.x,_.y)&&Zt(_.prev,_,_.next)>=0)return!1;_=_.prevZ}for(;x&&x.z<=y;){if(x.x>=d&&x.x<=v&&x.y>=p&&x.y<=g&&x!==r&&x!==o&&Mu(a,u,l,f,c,h,x.x,x.y)&&Zt(x.prev,x,x.next)>=0)return!1;x=x.nextZ}return!0}function K2(i,e){let t=i;do{let n=t.prev,r=t.next.next;!ka(n,r)&&Gx(n,t,t.next,r)&&bu(n,r)&&bu(r,n)&&(e.push(n.i,t.i,r.i),wu(t),wu(t.next),t=i=r),t=t.next}while(t!==i);return so(t)}function j2(i,e,t,n,r,s){let o=i;do{let a=o.next.next;for(;a!==o.prev;){if(o.i!==a.i&&aT(o,a)){let l=Vx(o,a);o=so(o,o.next),l=so(l,l.next),Su(o,e,t,n,r,s,0),Su(l,e,t,n,r,s,0);return}a=a.next}o=o.next}while(o!==i)}function Q2(i,e,t,n){let r=[];for(let s=0,o=e.length;s<o;s++){let a=e[s]*n,l=s<o-1?e[s+1]*n:i.length,c=zx(i,a,l,n,!1);c===c.next&&(c.steiner=!0),r.push(oT(c))}r.sort(eT);for(let s=0;s<r.length;s++)t=tT(r[s],t);return t}function eT(i,e){let t=i.x-e.x;if(t===0&&(t=i.y-e.y,t===0)){let n=(i.next.y-i.y)/(i.next.x-i.x),r=(e.next.y-e.y)/(e.next.x-e.x);t=n-r}return t}function tT(i,e){let t=nT(i,e);if(!t)return e;let n=Vx(t,i);return so(n,n.next),so(t,t.next)}function nT(i,e){let t=e,n=i.x,r=i.y,s=-1/0,o;if(ka(i,t))return t;do{if(ka(i,t.next))return t.next;if(r<=t.y&&r>=t.next.y&&t.next.y!==t.y){let f=t.x+(r-t.y)*(t.next.x-t.x)/(t.next.y-t.y);if(f<=n&&f>s&&(s=f,o=t.x<t.next.x?t:t.next,f===n))return o}t=t.next}while(t!==e);if(!o)return null;let a=o,l=o.x,c=o.y,u=1/0;t=o;do{if(n>=t.x&&t.x>=l&&n!==t.x&&kx(r<c?n:s,r,l,c,r<c?s:n,r,t.x,t.y)){let f=Math.abs(r-t.y)/(n-t.x);bu(t,i)&&(f<u||f===u&&(t.x>o.x||t.x===o.x&&iT(o,t)))&&(o=t,u=f)}t=t.next}while(t!==a);return o}function iT(i,e){return Zt(i.prev,i,e.prev)<0&&Zt(e.next,i,i.next)<0}function rT(i,e,t,n){let r=i;do r.z===0&&(r.z=Jm(r.x,r.y,e,t,n)),r.prevZ=r.prev,r.nextZ=r.next,r=r.next;while(r!==i);r.prevZ.nextZ=null,r.prevZ=null,sT(r)}function sT(i){let e,t=1;do{let n=i,r;i=null;let s=null;for(e=0;n;){e++;let o=n,a=0;for(let c=0;c<t&&(a++,o=o.nextZ,!!o);c++);let l=t;for(;a>0||l>0&&o;)a!==0&&(l===0||!o||n.z<=o.z)?(r=n,n=n.nextZ,a--):(r=o,o=o.nextZ,l--),s?s.nextZ=r:i=r,r.prevZ=s,s=r;n=o}s.nextZ=null,t*=2}while(e>1);return i}function Jm(i,e,t,n,r){return i=(i-t)*r|0,e=(e-n)*r|0,i=(i|i<<8)&16711935,i=(i|i<<4)&252645135,i=(i|i<<2)&858993459,i=(i|i<<1)&1431655765,e=(e|e<<8)&16711935,e=(e|e<<4)&252645135,e=(e|e<<2)&858993459,e=(e|e<<1)&1431655765,i|e<<1}function oT(i){let e=i,t=i;do(e.x<t.x||e.x===t.x&&e.y<t.y)&&(t=e),e=e.next;while(e!==i);return t}function kx(i,e,t,n,r,s,o,a){return(r-o)*(e-a)>=(i-o)*(s-a)&&(i-o)*(n-a)>=(t-o)*(e-a)&&(t-o)*(s-a)>=(r-o)*(n-a)}function Mu(i,e,t,n,r,s,o,a){return!(i===o&&e===a)&&kx(i,e,t,n,r,s,o,a)}function aT(i,e){return i.next.i!==e.i&&i.prev.i!==e.i&&!lT(i,e)&&(bu(i,e)&&bu(e,i)&&cT(i,e)&&(Zt(i.prev,i,e.prev)||Zt(i,e.prev,e))||ka(i,e)&&Zt(i.prev,i,i.next)>0&&Zt(e.prev,e,e.next)>0)}function Zt(i,e,t){return(e.y-i.y)*(t.x-e.x)-(e.x-i.x)*(t.y-e.y)}function ka(i,e){return i.x===e.x&&i.y===e.y}function Gx(i,e,t,n){let r=pd(Zt(i,e,t)),s=pd(Zt(i,e,n)),o=pd(Zt(t,n,i)),a=pd(Zt(t,n,e));return!!(r!==s&&o!==a||r===0&&dd(i,t,e)||s===0&&dd(i,n,e)||o===0&&dd(t,i,n)||a===0&&dd(t,e,n))}function dd(i,e,t){return e.x<=Math.max(i.x,t.x)&&e.x>=Math.min(i.x,t.x)&&e.y<=Math.max(i.y,t.y)&&e.y>=Math.min(i.y,t.y)}function pd(i){return i>0?1:i<0?-1:0}function lT(i,e){let t=i;do{if(t.i!==i.i&&t.next.i!==i.i&&t.i!==e.i&&t.next.i!==e.i&&Gx(t,t.next,i,e))return!0;t=t.next}while(t!==i);return!1}function bu(i,e){return Zt(i.prev,i,i.next)<0?Zt(i,e,i.next)>=0&&Zt(i,i.prev,e)>=0:Zt(i,e,i.prev)<0||Zt(i,i.next,e)<0}function cT(i,e){let t=i,n=!1,r=(i.x+e.x)/2,s=(i.y+e.y)/2;do t.y>s!=t.next.y>s&&t.next.y!==t.y&&r<(t.next.x-t.x)*(s-t.y)/(t.next.y-t.y)+t.x&&(n=!n),t=t.next;while(t!==i);return n}function Vx(i,e){let t=Km(i.i,i.x,i.y),n=Km(e.i,e.x,e.y),r=i.next,s=e.prev;return i.next=e,e.prev=i,t.next=r,r.prev=t,n.next=t,t.prev=n,s.next=n,n.prev=s,n}function Ox(i,e,t,n){let r=Km(i,e,t);return n?(r.next=n.next,r.prev=n,n.next.prev=r,n.next=r):(r.prev=r,r.next=r),r}function wu(i){i.next.prev=i.prev,i.prev.next=i.next,i.prevZ&&(i.prevZ.nextZ=i.nextZ),i.nextZ&&(i.nextZ.prevZ=i.prevZ)}function Km(i,e,t){return{i,x:e,y:t,prev:null,next:null,z:0,prevZ:null,nextZ:null,steiner:!1}}function uT(i,e,t,n){let r=0;for(let s=e,o=t-n;s<t;s+=n)r+=(i[o]-i[s])*(i[s+1]+i[o+1]),o=s;return r}var dt=(i,e=[])=>({outline:i,holes:e}),Tu=(i,e,t,n,r=18)=>Array.from({length:r},(s,o)=>{let a=o/r*Math.PI*2;return[i+Math.cos(a)*t,e+Math.sin(a)*n]}),Wt=(i,e)=>{let t=n=>i.map((r,s)=>{let o=i[Math.max(0,s-1)],a=i[Math.min(i.length-1,s+1)],l=Math.hypot(a[0]-o[0],a[1]-o[1]);return[r[0]-(a[1]-o[1])/l*e/2*n,r[1]+(a[0]-o[0])/l*e/2*n]});return dt([...t(1),...t(-1).reverse()])},pe=(i,e,t=.6)=>[i,e,t],hT={id:"aries",regions:[dt([[6,40],[9,33],[17,29],[23,25],[29,26],[34,23],[40,25],[45,23],[51,26],[57,25],[63,29],[69,29],[74,34],[78,38],[82,38],[85,41],[91,40],[96,44],[96,48],[92,51],[89,50],[89,58],[86,62],[82,61],[79,57],[78,65],[79,78],[75,79],[72,74],[72,62],[68,55],[64,53],[63,69],[65,76],[62,77],[58,72],[57,56],[48,56],[40,55],[33,58],[30,67],[30,74],[33,77],[29,79],[25,76],[23,65],[20,58],[15,58],[14,67],[16,74],[13,76],[10,74],[9,61],[8,53],[7,47],[5,44]]),dt(Tu(77,43,8,9,24),[Tu(77,43,4.5,5.3,18)]),dt([[83,39],[80,36],[80,32],[83,30],[86,31],[88,34],[88,39],[86,43]]),dt([[88,41],[89,36],[93,35],[92,39]])],nodes:[pe(10,62,1),pe(72,46,1),pe(82,51,.8),pe(29,51,.35),pe(53,45,.35),pe(77,38,.5)],lines:[[0,1],[1,2],[0,3],[3,4],[4,1],[1,5]]},fT={id:"taurus",regions:[dt([[5,39],[10,34],[20,30],[32,29],[46,30],[57,32],[68,30],[76,32],[81,35],[84,37],[90,38],[96,42],[96,48],[90,51],[85,50],[80,46],[78,54],[78,67],[82,75],[77,77],[73,73],[71,59],[67,52],[62,54],[62,69],[65,75],[61,76],[57,71],[55,55],[42,54],[29,54],[25,60],[24,72],[28,76],[22,77],[19,73],[18,57],[13,53],[11,68],[14,74],[10,75],[7,71],[7,53],[4,47]]),dt([[77,38],[72,32],[70,26],[70,19],[72,21],[74,28],[80,33],[82,38]]),dt([[82,37],[85,30],[87,24],[86,19],[89,21],[90,27],[89,34],[87,40]]),Wt([[7,39],[3,43],[3,57],[5,65]],1.8),dt([[75,35],[70,34],[68,37],[73,40]])],nodes:[pe(80,41,1),pe(88,47,.8),pe(72,33,.7),pe(72,23,.75),pe(88,23,.9),pe(52,40,.65),pe(22,44,.55),pe(11,64,.65),pe(62,67,.45)],lines:[[0,1],[0,2],[2,3],[0,4],[0,5],[5,6],[6,7],[5,8]]},dT={id:"gemini",regions:[dt([[34,15],[28,16],[25,21],[26,27],[30,30],[30,34],[25,34],[20,40],[15,51],[12,64],[15,66],[19,57],[24,48],[26,56],[24,66],[23,76],[18,87],[13,91],[14,94],[20,94],[26,87],[31,74],[34,64],[38,75],[43,87],[40,91],[43,94],[48,93],[49,87],[45,72],[41,62],[40,53],[44,43],[49,41],[52,39],[50,36],[44,38],[39,34],[38,30],[42,25],[41,19],[38,16]]),dt([[57,12],[53,16],[52,21],[55,26],[57,29],[56,33],[51,35],[45,39],[42,44],[44,47],[49,43],[55,41],[57,51],[54,60],[51,70],[52,81],[48,86],[50,89],[57,89],[59,83],[59,72],[62,66],[67,77],[72,82],[70,88],[73,91],[79,88],[78,82],[73,69],[68,61],[67,53],[68,47],[75,47],[82,44],[84,37],[83,34],[80,36],[79,42],[73,42],[69,39],[64,33],[64,28],[68,23],[68,18],[65,13],[61,11]]),dt([[35,16],[31,19],[29,25],[26,27],[23,25],[23,20],[26,15],[32,12],[38,13],[42,16],[44,22],[42,26],[40,21]])],nodes:[pe(33,23,.85),pe(61,20,1),pe(29,38,.6),pe(58,37,.7),pe(15,61,.6),pe(82,40,.65),pe(29,60,.55),pe(61,60,.6),pe(23,85,.8),pe(45,87,.65),pe(55,83,.55),pe(75,83,.65)],lines:[[0,1],[0,2],[1,3],[2,4],[3,5],[2,6],[3,7],[6,8],[6,9],[7,10],[7,11]]},pT={id:"cancer",regions:[dt([[30,52],[35,45],[43,43],[47,45],[50,41],[54,44],[62,45],[68,50],[72,59],[71,68],[67,76],[59,80],[46,81],[35,77],[29,68],[28,60]]),Wt([[33,53],[25,47],[21,41],[18,34]],4),dt([[18,35],[12,31],[9,24],[9,17],[12,10],[16,6],[18,7],[16,14],[16,21],[19,25],[22,22],[23,17],[25,14],[27,19],[27,27],[24,32],[21,35]]),Wt([[66,53],[75,48],[78,41],[82,33]],4),dt([[81,34],[77,30],[76,25],[78,19],[82,15],[83,18],[81,24],[83,26],[87,23],[89,17],[88,11],[91,14],[94,21],[95,27],[92,32],[87,35],[83,36]]),...[0,1,2,3].flatMap(i=>[Wt([[31,56+i*5],[23-i,54+i*7],[15-i,59+i*7],[10,64+i*7]],2.2),Wt([[70,56+i*5],[79+i,55+i*7],[86+i,60+i*7],[91,65+i*7]],2.2)]),dt(Tu(46,44,1.5,3,8)),dt(Tu(56,44,1.5,3,8))],nodes:[pe(18,33,.8),pe(45,49,1),pe(60,48,.85),pe(88,31,1),pe(60,65,.85),pe(47,71,.85),pe(26,84,.75)],lines:[[0,1],[1,2],[2,3],[2,4],[4,5],[5,1],[5,6]]},mT={id:"leo",regions:[dt([[11,52],[17,44],[24,41],[32,40],[42,42],[50,41],[56,37],[59,30],[64,24],[69,22],[72,18],[74,21],[79,19],[82,22],[85,21],[87,25],[91,26],[90,31],[94,34],[96,39],[93,41],[88,40],[85,37],[83,41],[87,44],[92,46],[94,49],[92,52],[87,51],[84,48],[81,49],[82,53],[78,59],[77,64],[84,64],[91,65],[95,68],[94,71],[91,72],[89,69],[76,70],[67,68],[65,63],[59,65],[48,65],[38,63],[31,66],[23,68],[11,68],[8,65],[12,62],[20,61],[27,57],[28,52],[22,50],[17,53],[14,57],[10,58]]),dt([[15,47],[10,51],[7,58],[7,64],[11,68],[16,69],[20,68],[18,71],[12,72],[6,70],[3,66],[3,60],[6,53],[10,48]]),dt([[64,35],[67,31],[71,28],[76,28],[80,31],[83,34],[81,35],[76,32],[72,32],[68,35]]),dt(Tu(86,33,1.4,.7,8))],nodes:[pe(17,49,.7),pe(29,47,.75),pe(64,39,.75),pe(77,27,.6),pe(85,25,.65),pe(80,45,.55),pe(72,56,.8),pe(65,66,1),pe(88,69,.7),pe(91,65,.55),pe(30,63,.7),pe(8,65,.9)],lines:[[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,7],[7,8],[8,9],[7,10],[10,11],[11,0]]},gT={id:"virgo",regions:[dt([[45,9],[39,12],[37,18],[39,23],[43,27],[44,30],[39,33],[35,40],[36,51],[40,58],[36,67],[32,77],[33,81],[40,84],[48,85],[59,83],[63,78],[59,70],[56,60],[53,50],[54,42],[58,46],[64,52],[66,50],[62,42],[56,35],[51,31],[50,27],[54,22],[54,17],[51,12]]),dt([[38,33],[32,30],[29,26],[27,28],[27,35],[29,44],[32,48],[35,46],[34,54],[31,55],[29,50],[25,44],[23,35],[22,24],[25,19],[28,22],[33,29]]),dt([[51,33],[57,27],[60,26],[63,30],[67,37],[69,46],[68,52],[65,58],[62,57],[63,50],[62,43],[59,37],[56,34],[56,44],[54,49]]),dt([[39,82],[42,83],[43,93],[46,96],[43,97],[39,95]]),dt([[51,84],[54,83],[54,93],[57,95],[55,97],[51,96]]),Wt([[34,40],[34,54],[30,64]],1.1)],nodes:[pe(45,12,.9),pe(42,22,.55),pe(35,40,.6),pe(48,40,.8),pe(63,53,.85),pe(43,65,.75),pe(40,77,.55),pe(54,79,.75),pe(61,78,.6),pe(41,94,.55),pe(53,94,.55)],lines:[[0,1],[1,3],[2,3],[3,4],[3,5],[5,6],[6,7],[7,8],[6,9],[7,10]]},vT={id:"libra",regions:[dt([[47,16],[51,15],[54,18],[56,25],[56,33],[53,38],[53,49],[51,59],[51,76],[57,80],[61,86],[58,90],[49,91],[39,88],[37,84],[41,80],[46,77],[47,60],[47,48],[49,37],[50,31],[48,25]]),Wt([[17,17],[50,21],[83,43]],2),Wt([[17,17],[7,59]],.85),Wt([[17,17],[29,58]],.85),dt([[6,58],[11,59],[19,59],[27,56],[31,57],[29,63],[24,66],[16,67],[9,64]]),Wt([[83,43],[69,79]],.85),Wt([[83,43],[94,75]],.85),dt([[68,78],[73,79],[82,78],[90,75],[95,74],[94,81],[88,85],[79,87],[71,85]])],nodes:[pe(17,17,1),pe(51,21,1),pe(83,43,1),pe(16,62,.85),pe(77,82,.85),pe(30,60,.4),pe(92,77,.4)],lines:[[0,1],[1,2],[0,3],[3,5],[5,0],[2,4],[4,6],[6,2]]},xT={id:"scorpius",regions:[dt([[40,42],[45,35],[52,34],[57,38],[61,44],[60,52],[56,61],[50,68],[43,69],[38,64],[36,57],[37,49]]),Wt([[48,38],[55,31],[62,26]],4),dt([[61,27],[56,23],[55,17],[59,12],[64,10],[72,11],[79,14],[83,20],[81,23],[77,19],[70,17],[64,18],[62,21],[67,24],[75,25],[80,24],[78,28],[71,31],[65,30]]),Wt([[58,44],[69,49],[73,53]],4),dt([[72,52],[74,48],[76,43],[76,38],[79,41],[81,46],[80,53],[76,59],[71,62],[65,61],[62,57],[62,51],[65,47],[68,45],[67,50],[66,55],[69,57]]),Wt([[43,65],[37,73],[28,78],[20,76],[14,71],[12,64],[14,60]],5),dt([[15,62],[11,64],[7,62],[6,57],[9,53],[14,52],[19,54],[21,58],[18,63],[17,59],[14,58],[12,59]]),...[0,1,2,3].flatMap(i=>[Wt([[39,44+i*5],[29,39+i*5],[22,39+i*5]],1.5),Wt([[59,47+i*4],[61+i*2,57+i*5],[58+i*2,64+i*5]],1.6)])],nodes:[pe(80,20,.8),pe(63,27,.85),pe(50,38,1),pe(73,49,.6),pe(68,58,.6),pe(46,48,.5),pe(44,59,.55),pe(39,67,.7),pe(28,77,.7),pe(16,72,.6),pe(12,63,.55),pe(17,57,.55)],lines:[[0,1],[1,2],[2,3],[3,4],[4,2],[2,5],[5,6],[6,7],[7,8],[8,9],[9,10],[10,11]]},yT={id:"sagittarius",regions:[dt([[22,48],[30,43],[39,43],[46,46],[50,43],[49,37],[48,32],[48,27],[45,24],[44,19],[46,14],[51,12],[56,14],[58,18],[57,23],[54,26],[55,29],[60,32],[65,34],[70,35],[74,31],[77,31],[76,35],[72,39],[65,39],[57,37],[56,42],[60,48],[65,51],[68,57],[67,63],[73,69],[76,76],[73,80],[70,79],[70,74],[64,67],[62,63],[59,61],[55,62],[58,69],[55,78],[51,80],[50,77],[53,71],[49,65],[44,63],[37,63],[33,61],[29,65],[24,74],[18,83],[12,91],[7,93],[6,90],[12,85],[17,77],[23,64],[23,58],[19,55]]),dt([[31,60],[35,64],[34,70],[40,77],[42,83],[48,89],[46,92],[41,90],[38,85],[32,80],[29,73],[27,68]]),dt([[24,48],[19,44],[12,44],[7,47],[3,48],[7,51],[13,49],[16,51],[22,54]]),Wt([[52,30],[46,31],[39,34],[42,37],[54,35]],2.4),Wt([[76,17],[82,24],[84,32],[83,40],[79,47]],1.5),Wt([[76,17],[78,32],[79,47]],.55),Wt([[42,35],[89,33]],.65),dt([[88,31],[92,33],[88,35]])],nodes:[pe(51,16,.7),pe(51,30,.65),pe(40,35,.6),pe(76,33,.7),pe(90,33,.85),pe(54,48,.75),pe(62,59,.7),pe(72,77,.6),pe(45,89,.6),pe(31,58,.8),pe(9,90,.8),pe(10,48,.6)],lines:[[0,1],[1,2],[2,3],[3,4],[1,5],[5,6],[6,7],[6,9],[9,8],[9,10],[9,11],[5,9]]},_T={id:"capricornus",regions:[dt([[13,70],[23,69],[33,66],[44,63],[54,56],[61,48],[65,39],[70,34],[75,35],[79,39],[79,44],[84,48],[85,52],[83,55],[79,54],[77,51],[75,53],[75,61],[78,70],[77,78],[73,81],[70,79],[71,74],[69,67],[64,66],[62,71],[57,69],[53,70],[50,75],[44,81],[36,86],[28,87],[22,83],[18,78],[12,76],[7,83],[7,76],[3,68],[10,70]]),dt([[68,38],[69,30],[69,22],[67,13],[64,7],[67,9],[71,17],[74,25],[74,34]]),dt([[75,38],[77,28],[77,18],[75,10],[78,13],[80,23],[81,34],[79,41]]),dt([[69,37],[65,34],[61,36],[65,40]]),dt([[51,71],[54,73],[47,82],[41,88],[32,90],[24,88],[20,84],[25,86],[32,87],[39,84],[45,79]])],nodes:[pe(73,42,1),pe(64,55,.7),pe(49,65,.65),pe(35,70,.6),pe(13,73,.75),pe(30,86,.65),pe(50,83,.4),pe(75,76,.65)],lines:[[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,7],[7,0],[0,5]]},MT={id:"aquarius",regions:[dt([[32,13],[27,16],[25,22],[28,28],[32,30],[33,34],[28,38],[25,46],[28,54],[33,60],[31,69],[29,81],[25,88],[27,91],[33,90],[36,83],[37,71],[41,64],[45,73],[48,84],[53,90],[58,91],[60,88],[54,83],[52,70],[47,61],[46,52],[44,44],[48,43],[53,39],[55,33],[53,30],[50,34],[48,37],[42,38],[38,34],[38,30],[42,26],[43,20],[40,15]]),Wt([[30,39],[22,40],[19,35],[21,29],[28,31],[34,38],[47,41]],3),dt([[49,28],[54,24],[62,23],[66,26],[70,26],[70,31],[66,34],[65,42],[61,47],[55,46],[51,42],[52,35]]),...[0,1,2].map(i=>Wt([[64+i*2,35],[70+i*2,45],[69+i*3,57],[65+i*3,65],[70+i*3,75],[68+i*3,85],[72+i*3,93]],1.4))],nodes:[pe(34,20,.7),pe(32,38,.65),pe(20,36,.6),pe(47,40,.8),pe(57,28,.6),pe(67,29,.6),pe(66,42,.6),pe(68,58,.7),pe(68,74,.6),pe(74,90,.65),pe(37,61,.7),pe(30,88,.6),pe(54,88,.6)],lines:[[0,1],[1,2],[1,3],[3,4],[4,5],[5,6],[6,7],[7,8],[8,9],[1,10],[10,11],[10,12]]},ST={id:"pisces",regions:[dt([[17,55],[23,54],[28,57],[31,61],[29,64],[23,64],[18,62],[15,60],[10,62],[11,58],[9,54],[15,57]]),dt([[75,17],[79,12],[84,12],[87,17],[86,23],[82,27],[78,27],[75,23],[71,25],[72,21],[70,17],[75,19]]),Wt([[29,62],[37,70],[50,76],[63,87]],.6),Wt([[63,87],[59,74],[58,63],[61,49],[66,35],[77,26]],.6)],nodes:[pe(15,58,.5),pe(25,60,.6),pe(36,69,.6),pe(49,76,.65),pe(63,87,.9),pe(58,62,.55),pe(60,52,.5),pe(66,34,.6),pe(77,26,.6),pe(80,14,.9),pe(86,19,.65),pe(82,26,.55),pe(73,23,.45)],lines:[[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,7],[7,8],[8,9],[9,10],[10,11],[11,12],[12,9]]},Ga=[hT,fT,dT,pT,mT,gT,vT,xT,yT,_T,MT,ST].map(i=>({...i,regions:i.regions.map(e=>({outline:e.outline.map(([t,n])=>[t,100-n]),holes:e.holes.map(t=>t.map(([n,r])=>[n,100-r]))})),nodes:i.nodes.map(([e,t,n])=>[e,100-t,n])}));var Ct=12,Ur=2.8,n0=7.6,Cu=2.6,Au=Ur+n0+Cu,Va=2.5,oo=1.78,Ru=Va*oo,md=.85,qx=Ru*1.06,Yx=Va*1.06,Zx=md*1.2,r0=.5,Eu=.26,s0=.022,o0=.072,a0=.0055,l0=.017,Fn=[{id:"aries",cn:"\u767D\u7F8A",en:"Aries"},{id:"taurus",cn:"\u91D1\u725B",en:"Taurus"},{id:"gemini",cn:"\u53CC\u5B50",en:"Gemini"},{id:"cancer",cn:"\u5DE8\u87F9",en:"Cancer"},{id:"leo",cn:"\u72EE\u5B50",en:"Leo"},{id:"virgo",cn:"\u5904\u5973",en:"Virgo"},{id:"libra",cn:"\u5929\u79E4",en:"Libra"},{id:"scorpius",cn:"\u5929\u874E",en:"Scorpius"},{id:"sagittarius",cn:"\u5C04\u624B",en:"Sagittarius"},{id:"capricornus",cn:"\u6469\u7FAF",en:"Capricornus"},{id:"aquarius",cn:"\u6C34\u74F6",en:"Aquarius"},{id:"pisces",cn:"\u53CC\u9C7C",en:"Pisces"}];function Qm(i){return(i()+i()+i()-1.5)*.82}function Hx(i){let e,t,n,r;do e=i()*2-1,t=i()*2-1,n=i()*2-1,r=e*e+t*t+n*n;while(r>1||r<1e-6);let s=1/Math.sqrt(r);return[e*s,t*s,n*s]}var e0=new Array(Ct);function Ha(i){let e=(i%Ct+Ct)%Ct;if(!e0[e]){let t=Ga[e].regions.flatMap(h=>h.outline),n=t.map(h=>h[0]),r=t.map(h=>h[1]),s=Math.min(...n),o=Math.max(...n),a=Math.min(...r),l=Math.max(...r),c=o-s,u=l-a,f=Math.min(Ru*2/c,Va*2/u);e0[e]={cx:(s+o)/2,cy:(a+l)/2,k:f,kz:1,w:c*f/2,h:u*f/2}}return e0[e]}var lr=560,t0=new Array(Ct);function Wx(i,e,t){let n=!1;for(let r=0,s=t.length-1;r<t.length;s=r++){let o=t[r],a=t[s];o[1]>e!=a[1]>e&&i<(a[0]-o[0])*(e-o[1])/(a[1]-o[1])+o[0]&&(n=!n)}return n}function $x(i,e,t){let n=0;for(let r of Ga[i].regions){if(!Wx(e,t,r.outline)||r.holes.some(o=>Wx(e,t,o)))continue;let s=1/0;for(let o of[r.outline,...r.holes])o.forEach((a,l)=>{let c=o[(l+1)%o.length],u=c[0]-a[0],f=c[1]-a[1],h=qn(((e-a[0])*u+(t-a[1])*f)/(u*u+f*f),0,1);s=Math.min(s,Math.hypot(e-a[0]-u*h,t-a[1]-f*h))});n=Math.max(n,s*Ha(i).k)}return Eu+.06+Math.min(md-Eu-.08,Math.sqrt(n)*.52)}var i0=i=>-(i-Eu)*.8-.08;function bT(i,e,t){let n=new Float32Array(i.length*3);for(let[r,s,o]of e){let a=i[r],l=i[s],c=i[o],u=l[0]-a[0],f=l[1]-a[1],h=t[s]-t[r],d=c[0]-a[0],p=c[1]-a[1],v=t[o]-t[r],g=f*v-h*p,m=h*d-u*v,y=u*p-f*d;y<0&&(g=-g,m=-m,y=-y);for(let _ of[r,s,o])n[_*3]+=g,n[_*3+1]+=m,n[_*3+2]+=y}for(let r=0;r<n.length;r+=3){let s=Math.hypot(n[r],n[r+1],n[r+2]);s>1e-9?(n[r]/=s,n[r+1]/=s,n[r+2]/=s):(n[r]=0,n[r+1]=0,n[r+2]=1)}return n}function c0(i){if(t0[i])return t0[i];let e=[],t=[],n=[];for(let f of Ga[i].regions){let h=[f.outline,...f.holes],d=e.length,p=[],v=[];h.forEach((m,y)=>{y&&v.push(p.length/2);let _=e.length;m.forEach(x=>{e.push(x.slice()),p.push(...x)}),y||m.forEach((x,S)=>n.push([_+S,_+(S+1)%m.length]))});let g=jm(p,v,2);for(let m=0;m<g.length;m+=3)t.push(g.slice(m,m+3).map(y=>d+y))}let r=Nn("zodiac-contour-mesh:"+Ga[i].id);for(;e.length<lr;){let f=null,h=-1;for(let _ of t)for(let x=0;x<3;x++){let S=_[x],b=_[(x+1)%3],E=e[S],M=e[b],T=(E[0]-M[0])**2+(E[1]-M[1])**2;T>h&&(h=T,f=[S,b])}let[d,p]=f,v=e[d],g=e[p],m=.43+r()*.14,y=e.length;e.push([v[0]+(g[0]-v[0])*m,v[1]+(g[1]-v[1])*m]);for(let _=t.length-1;_>=0;_--){let x=t[_];if(!(!x.includes(d)||!x.includes(p)))for(let S=0;S<3;S++){let b=x[S],E=x[(S+1)%3],M=x[(S+2)%3];if(b===d&&E===p||b===p&&E===d){t[_]=[b,y,M],t.push([y,E,M]);break}}}}let s=0,o=0,a=t.map(([f,h,d])=>{let p=e[f],v=e[h],g=e[d];return s+=Math.abs((v[0]-p[0])*(g[1]-p[1])-(v[1]-p[1])*(g[0]-p[0]))/2,s}),l=n.map(([f,h])=>(o+=Math.hypot(e[f][0]-e[h][0],e[f][1]-e[h][1]),o)),c=e.map(([f,h])=>$x(i,f,h)),u=bT(e,t,c);return t0[i]={points:e,triangles:t,contours:n,areas:a,lengths:l,totalArea:s,totalLength:o,depths:c,normals:u}}function Xx(i,e){let t=0,n=i.length-1;for(;t<n;){let r=t+n>>>1;e<i[r]?n=r:t=r+1}return t}function Jx(i,e,t,n=!1,r=null){let s=c0(i),o=Ha(i),a=Nn(t),l=new Float32Array(e*3);for(let c=0;c<e;c++){let u,f,h,d=0,p=0,v=1;if(a()<.18){let[m,y]=s.contours[Xx(s.lengths,a()*s.totalLength)],_=a(),x=s.points[m],S=s.points[y];u=x[0]+(S[0]-x[0])*_,f=x[1]+(S[1]-x[1])*_,h=s.depths[m]*(1-_)+s.depths[y]*_,d=s.normals[m*3]*(1-_)+s.normals[y*3]*_,p=s.normals[m*3+1]*(1-_)+s.normals[y*3+1]*_,v=s.normals[m*3+2]*(1-_)+s.normals[y*3+2]*_}else{let m=s.triangles[Xx(s.areas,a()*s.totalArea)],[y,_,x]=m.map(E=>s.points[E]),S=Math.sqrt(a()),b=a();u=y[0]*(1-S)+_[0]*S*(1-b)+x[0]*S*b,f=y[1]*(1-S)+_[1]*S*(1-b)+x[1]*S*b,h=s.depths[m[0]]*(1-S)+s.depths[m[1]]*S*(1-b)+s.depths[m[2]]*S*b;for(let E=0;E<3;E+=1){let M=[1-S,S*(1-b),S*b][E],T=m[E]*3;d+=s.normals[T]*M,p+=s.normals[T+1]*M,v+=s.normals[T+2]*M}}l[c*3]=(u-o.cx)*o.k,l[c*3+1]=(f-o.cy)*o.k;let g=n?1:.12+.88*Math.pow(a(),.58);if(l[c*3+2]=n?h:i0(h)+(h-i0(h))*g,r){let m=n?1:g*2-1,y=d,_=p,x=v*m,S=Math.hypot(y,_,x);S>1e-6?(y/=S,_/=S,x/=S):(y=0,_=0,x=1),r[c*3]=y,r[c*3+1]=_,r[c*3+2]=x}}return l}function gd(i,e){let t=(i%Ct+Ct)%Ct,n=new Float32Array(e*3),r=Jx(t,e,"zodiac-shape:"+Fn[t].id+":"+e,!1,n),s=Nn("zodiac-shine:"+Fn[t].id+":"+e),o=new Float32Array(e);for(let a=0;a<e;a++)o[a]=.4+Math.pow(s(),3)*.8;return{pos:r,normals:n,shine:o,sign:Fn[t]}}var Wa=Ga.map(({nodes:i,lines:e})=>({nodes:i,lines:e}));function wT(i,e,t){let n=c0(i);for(let[r,s,o]of n.triangles){let a=n.points[r],l=n.points[s],c=n.points[o],u=(l[1]-c[1])*(a[0]-c[0])+(c[0]-l[0])*(a[1]-c[1]),f=((l[1]-c[1])*(e-c[0])+(c[0]-l[0])*(t-c[1]))/u,h=((c[1]-a[1])*(e-c[0])+(a[0]-c[0])*(t-c[1]))/u;if(f>=-1e-6&&h>=-1e-6&&f+h<=1+1e-6)return n.depths[r]*f+n.depths[s]*h+n.depths[o]*(1-f-h)}return $x(i,e,t)}function Pu(i,e=0){let t=Math.max(0,Math.floor(Number(i)||0)),n=Math.max(0,Math.floor(Number(e)||0)),r=s=>{let o=Math.imul(t+2654435769,2246822507)^Math.imul(n+2135587861,3266489909)^s;return o=Math.imul(o^o>>>15,739982445),o=Math.imul(o^o>>>12,695872825),((o^o>>>15)>>>0)/4294967296};return{gather:(t*3+n*5)%8,disperse:(t*5+n*3+1)%8,direction:(t+n)%2?-1:1,stagger:.3+r(31)*.3,spin:.65+r(47)*.9,arc:.72+r(63)*.65}}function vd(i){let e=(i%Ct+Ct)%Ct,t=Wa[e],n=Ha(e),r=new Float32Array(t.nodes.length),s=new Float32Array(t.nodes.length),o=new Float32Array(t.nodes.length),a=new Float32Array(t.nodes.length);return t.nodes.forEach(([l,c,u],f)=>{r[f]=(l-n.cx)*n.k,s[f]=(c-n.cy)*n.k,o[f]=u,a[f]=wT(e,l,c)+.08}),{x:r,y:s,z:a,m:o,nodes:r.length,segments:t.lines.length,core:ls(r,s,t.lines,s0,a),halo:ls(r,s,t.lines,o0,a)}}function Kx(i){let e=i.length;if(e<3)return[];let t=1/0,n=-1/0,r=1/0,s=-1/0;for(let v=0;v<e;v+=1){let g=i[v];g.x<t&&(t=g.x),g.x>n&&(n=g.x),g.y<r&&(r=g.y),g.y>s&&(s=g.y)}let o=n-t||1,a=s-r||1,l=Math.max(o,a),c=(t+n)/2,u=(r+s)/2,f=[{x:c-20*l,y:u-l},{x:c,y:u+20*l},{x:c+20*l,y:u-l}].concat(i.map(v=>({x:v.x,y:v.y}))),h=[[0,1,2]],d=(v,g,m)=>{let y=v.x,_=v.y,x=g.x,S=g.y,b=m.x,E=m.y,M=2*(y*(S-E)+x*(E-_)+b*(_-S));if(Math.abs(M)<1e-12)return{x:0,y:0,r:1/0};let T=y*y+_*_,A=x*x+S*S,I=b*b+E*E,D=(T*(S-E)+A*(E-_)+I*(_-S))/M,B=(T*(b-x)+A*(y-b)+I*(x-y))/M,F=D-y,L=B-_;return{x:D,y:B,r:F*F+L*L}},p=[d(f[0],f[1],f[2])];for(let v=3;v<f.length;v+=1){let g=f[v],m=[];for(let b=0;b<h.length;b+=1){let E=p[b],M=g.x-E.x,T=g.y-E.y;M*M+T*T<=E.r&&m.push(b)}let y=new Map,_=(b,E)=>b<E?b+":"+E:E+":"+b;m.forEach(b=>{let[E,M,T]=h[b];[[E,M],[M,T],[T,E]].forEach(([A,I])=>{let D=_(A,I),B=y.get(D);B?B.n+=1:y.set(D,{u:A,v:I,n:1})})});let x=[],S=[];for(let b=0;b<h.length;b+=1)m.indexOf(b)<0&&(x.push(h[b]),S.push(p[b]));h=x,p.length=0,S.forEach(b=>p.push(b)),y.forEach(b=>{b.n===1&&(h.push([b.u,b.v,v]),p.push(d(f[b.u],f[b.v],g)))})}return h.filter(v=>v[0]>2&&v[1]>2&&v[2]>2).map(v=>[v[0]-3,v[1]-3,v[2]-3])}function xd(i,e){let t=(i%Ct+Ct)%Ct,n=c0(t),r=Ha(t),s=n.points.map(([E,M])=>({x:(E-r.cx)*r.k,y:(M-r.cy)*r.k})),o=n.triangles,a=Jx(t,e,"zodiac-figure-cloud:"+Fn[t].id+":"+e,!0),l=Nn("zodiac-figure-tint:"+Fn[t].id),c=new Map;o.forEach(([E,M,T])=>[[E,M],[M,T],[T,E]].forEach(([A,I])=>{let D=A<I?A+":"+I:I+":"+A;c.has(D)?c.get(D).count++:c.set(D,{u:A,v:I,count:1})}));let u=[...c.values()].filter(E=>E.count===1),f=o.length*2+u.length*2,h=new Float32Array(f*9),d=new Float32Array(f*9),p=new Map;o.forEach(([E,M,T],A)=>{[s[E],s[M],s[T]].forEach((B,F)=>{h[A*9+F*3]=B.x,h[A*9+F*3+1]=B.y,h[A*9+F*3+2]=n.depths[[E,M,T][F]]});let D=.62+l()*.66;for(let B=0;B<3;B+=1)d[A*9+B*3]=d[A*9+B*3+1]=d[A*9+B*3+2]=D;[[E,M],[M,T],[T,E]].forEach(([B,F])=>{let L=B<F?B+":"+F:F+":"+B;p.has(L)||p.set(L,[B,F])})});let v=o.length,g=E=>{let M=.68+l()*.28;E.forEach(([T,A],I)=>{let D=s[T],B=v*9+I*3;h.set([D.x,D.y,A?i0(n.depths[T]):n.depths[T]],B),d.set([M,M,M],B)}),v++};o.forEach(([E,M,T])=>g([[T,!0],[M,!0],[E,!0]])),u.forEach(({u:E,v:M})=>{g([[E,!1],[E,!0],[M,!0]]),g([[E,!1],[M,!0],[M,!1]])});let m=new Float32Array(s.length),y=new Float32Array(s.length);s.forEach((E,M)=>{m[M]=E.x,y[M]=E.y});let _=[];p.forEach(E=>_.push(E));let x=u.map(({u:E,v:M})=>[E,M]),S=n.depths.map(E=>E+.006),b=new Float32Array(s.length*3);return s.forEach((E,M)=>{b[M*3]=E.x,b[M*3+1]=E.y,b[M*3+2]=n.depths[M]+.006}),{cloud:a,mesh:{pos:h,tint:d},edgeCore:ls(m,y,_,a0,n.depths.map(E=>E+.006)),edgeHalo:ls(m,y,_,l0,n.depths.map(E=>E+.006)),contourCore:ls(m,y,x,.012,S),contourHalo:ls(m,y,x,.048,S),nodes:b,triangles:f,frontTriangles:o.length,segmentCount:p.size}}function ls(i,e,t,n,r){let s=(n||.03)/2,o=r??r0,a=new Float32Array(t.length*18);return t.forEach(([l,c],u)=>{let f=typeof o=="number"?o:o[l],h=typeof o=="number"?o:o[c],d=i[c]-i[l],p=e[c]-e[l],v=Math.hypot(d,p)||1;d/=v,p/=v;let g=-p*s,m=d*s,y=d*s,_=p*s,x=i[l]-y,S=e[l]-_,b=i[c]+y,E=e[c]+_,M=[x+g,S+m,x-g,S-m,b-g,E-m,x+g,S+m,b-g,E-m,b+g,E+m];for(let T=0;T<6;T+=1)a[u*18+T*3]=M[T*2],a[u*18+T*3+1]=M[T*2+1],a[u*18+T*3+2]=[f,f,h,f,h,h][T]}),a}function Iu(i,e){let t=Nn("zodiac-cloud:"+i),n=new Float32Array(e*3);for(let r=0;r<e;r+=1)if(t()<.28){let o=Hx(t),a=(t()-.5)*22,l=.35;n[r*3]=o[0]*a+Qm(t)*l,n[r*3+1]=o[1]*a*.6+Qm(t)*l,n[r*3+2]=o[2]*a+Qm(t)*l}else{let o=Hx(t),a=4.2+Math.pow(t(),.7)*12;n[r*3]=o[0]*a,n[r*3+1]=o[1]*a*.7,n[r*3+2]=o[2]*a}return n}function yd(i){let e=Nn("zodiac-seeds:"+i),t=new Float32Array(i);for(let n=0;n<i;n+=1)t[n]=e();return t}function u0(i){let e=Math.max(0,Number(i)||0),t=Math.floor(e/Au),n=e-t*Au;return n<Ur?{index:(t%Ct+Ct)%Ct,state:"gather",t:n,cycle:t}:n<Ur+n0?{index:(t%Ct+Ct)%Ct,state:"hold",t:n-Ur,cycle:t}:{index:(t%Ct+Ct)%Ct,state:"disperse",t:n-Ur-n0,cycle:t}}function h0(i){if(!i||!i.length)return 0;let e=0,t=Math.min(5,i.length);for(let n=0;n<t;n+=1)e+=qn(Number(i[n])||0);return qn(e/t)}function f0(i,e,t){return qn(i,e||3,t||17)}var _d={low:3200,medium:5200,high:7600},TT={low:1e3,medium:1700,high:2600},AT={low:28e3,medium:64e3,high:12e4},ET={low:70,medium:112,high:160},ao=36,wd=18,Lu=wd+Math.max(...Wa.map(i=>i.lines.length)),CT=[["#d96b66","#ffbaa2"],["#73b890","#b9f1c4"],["#ddb36d","#ffedb2"],["#a7bfd0","#e8efff"],["#e6ab51","#ffe49b"],["#a0bb76","#e1edac"],["#c794b9","#f6d0e7"],["#b76d94","#f5aecb"],["#9889d2","#d7c8ff"],["#66b3a6","#b0e9d3"],["#5da5cf","#b3e5fa"],["#8c87bf","#d6ccfa"]];function RT(i,e){let t=e/2,n=new Uint8Array(e*t*4),r=(u,f,h)=>{let d=(u%h+h)%h,p=Math.imul(d+193,374761393)^Math.imul(f+571,668265263);return p=Math.imul(p^p>>>13,1274126177),((p^p>>>16)>>>0)/4294967296},s=(u,f,h)=>{let d=Math.floor(u),p=Math.floor(f),v=u-d,g=f-p;v*=v*(3-2*v),g*=g*(3-2*g);let m=r(d,p,h),y=r(d+1,p,h),_=r(d,p+1,h),x=r(d+1,p+1,h);return(m+(y-m)*v)*(1-g)+(_+(x-_)*v)*g},o=(u,f,h)=>{let d=0,p=.5;for(let v=0;v<6;v++)d+=s(u*h,f*h,h)*p,h*=2,p*=.5;return d},a=Nn("zodiac-galactic-dust"),l=Math.hypot(.52,.84,.16);for(let u=0;u<t;u++){let f=(u+.5)/t,h=Math.sin(f*Math.PI),d=Math.cos(f*Math.PI);for(let p=0;p<e;p++){let v=(p+.5)/e,g=v*Math.PI*2,m=-Math.cos(g)*h,y=Math.sin(g)*h,_=o(v,f,12),x=o(v,f+.37,48),S=(.52*m+.84*d+.16*y)/l+.2,b=Math.exp(-Math.pow(S+(_-.5)*.24,2)*38),E=1-Math.pow(qn((x-.3)/.36),1.3)*.94,M=b*(.25+_*.9)*E*(.68+a()*.64),T=b*Math.pow(x,3)*.11,A=(u*e+p)*4;n[A]=Math.round(255*(M*.125+T)),n[A+1]=Math.round(255*(M*.08+T*.83)),n[A+2]=Math.round(255*(M*.142+T*.95)),n[A+3]=255}}let c=new i.DataTexture(n,e,t);return c.wrapS=i.RepeatWrapping,c.magFilter=i.LinearFilter,c.minFilter=i.LinearMipmapLinearFilter,c.generateMipmaps=!0,c.needsUpdate=!0,c}var PT=["varying float vY;","varying vec2 vUv;","varying vec3 vNdc;","void main() {","  vY = normalize(position).y;","  vUv = vec2(uv.x,1.0-uv.y);","  vec4 pos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);","  vNdc = pos.xyw;","  gl_Position = pos;","}"].join(`
`),IT=["precision mediump float;","uniform vec3 uTop;","uniform vec3 uMid;","uniform vec3 uBot;","uniform sampler2D uGalaxy;","uniform float uNeb;","uniform float uVignette;","varying float vY;","varying vec2 vUv;","varying vec3 vNdc;","void main() {","  float y = clamp(vY * 0.5 + 0.5, 0.0, 1.0);","  vec3 col = mix(uBot, uMid, smoothstep(0.0, 0.58, y));","  col = mix(col, uTop, smoothstep(0.46, 1.0, y));","  col += texture2D(uGalaxy,vUv).rgb*uNeb;","  vec2 ndc = vNdc.xy / max(1e-4, vNdc.z);","  col *= 1.0 - uVignette * smoothstep(0.28, 1.18, length(ndc * vec2(0.84, 1.0)));","  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);","}"].join(`
`);function LT(i,e){return new i.ShaderMaterial({uniforms:{uTop:{value:new i.Color(.006,.007,.011)},uMid:{value:new i.Color(.01,.011,.015)},uBot:{value:new i.Color(.003,.004,.006)},uGalaxy:{value:RT(i,e)},uNeb:{value:1},uVignette:{value:.3}},vertexShader:PT,fragmentShader:IT,side:i.BackSide,depthTest:!1,depthWrite:!1})}var DT=["attribute vec3 aEntry;","attribute vec3 aShape;","attribute vec3 aExit;","attribute vec3 aNormal;","attribute float aShine;","attribute float aPhase;","attribute float aSeed;","uniform float uTime;","uniform float uPixelRatio;","uniform float uBoost;","uniform float uTwinkle;","uniform float uMotion;","uniform float uSpin;","uniform float uLit;","uniform vec3 uKeyDir;","uniform int uVariant;","uniform int uState;","uniform float uK;","uniform float uStagger;","uniform float uSpinRate;","uniform float uArcScale;","varying float vAlpha;","varying float vShine;","varying float vCore;","varying float vLight;","varying float vRim;","varying float vDepth;","varying vec2 vDirection;","varying float vStretch;","vec3 flight(float t) {","  t = clamp(t,0.0,1.0);","  float ease = uState == 2 ? t*t : 1.0-(1.0-t)*(1.0-t);","  vec3 origin = uState == 2 ? aShape : aEntry;","  vec3 target = uState == 2 ? aExit : aShape;","  vec3 p = mix(origin,target,ease);","  float arc = sin(t*3.14159265)*uMotion*uArcScale;","  float angle = aPhase+t*(7.0+aSeed*8.0)*uSpin*uSpinRate;","  if(uVariant == 0) {","    p.xy += vec2(cos(angle),sin(angle))*arc*(1.2+aSeed*2.6);","    p.z += arc*sin(angle*0.7)*1.8;","  } else if(uVariant == 1) {","    p.xz += vec2(sin(angle),cos(angle))*arc*2.8;","    p.y += arc*(aSeed-0.5)*5.0;","  } else if(uVariant == 2) {","    p.x += arc*(aSeed-0.5)*7.0;","    p.y += sin(t*9.0+aPhase)*arc*1.2;","    p.z += arc*(aSeed*4.0-2.0);","  } else if(uVariant == 3) {","    p.xz += vec2(cos(angle),sin(angle))*arc*4.2;","    p.y += sin(angle*0.4)*arc*0.8;","  } else if(uVariant == 4) {","    vec3 direction = normalize(aShape+vec3(sin(aPhase),cos(aPhase),aSeed-0.5));","    p += direction*arc*(2.0+4.0*aSeed);","  } else if(uVariant == 5) {","    // \u87BA\u65CB\uFF1A\u7ED5\u673A\u4F4D\u8F74\u65CB\u8FDB\uFF0C\u534A\u5F84\u4E00\u8DEF\u6536\u5230\u96F6\uFF0C\u843D\u4F4D\u65F6\u6B63\u597D\u6536\u675F\u6210\u4E00\u70B9\u3002","    float radius = (1.0-t)*arc*(2.2+aSeed*3.4);","    p.xy += vec2(cos(angle*1.35),sin(angle*1.35))*radius;","    p.z += (1.0-t)*arc*(aSeed*3.0-1.2);","  } else if(uVariant == 6) {","    // \u661F\u96E8\uFF1A\u4ECE\u4E0A\u65B9\u659C\u843D\uFF0C\u6BCF\u9897\u7684\u4E0B\u843D\u65F6\u523B\u7531 aSeed \u9519\u5F00\u3002","    float drop = pow(1.0-t,2.0)*arc*(7.0+aSeed*7.0);","    p.y += drop+(aSeed-0.5)*arc*1.6;","    p.x += drop*0.34*sin(aPhase);","    p.z += drop*0.22*cos(aPhase*1.7);","  } else {","    // \u8109\u51B2\uFF1A\u6CBF\u76EE\u6807\u65B9\u5411\u7684\u5F84\u5411\u51B2\u51FB\uFF0C\u5148\u51B2\u8FC7\u5934\u518D\u56DE\u5F39\u3002","    vec3 direction = normalize(aShape+vec3(sin(aPhase*1.3),cos(aPhase),aSeed-0.5));","    p += direction*arc*sin(t*3.14159265*1.5)*(1.4+aSeed*2.2);","  }","  return p;","}","void main() {","  float k = clamp(uK*(1.0+uStagger)-aSeed*uStagger,0.0,1.0);","  vec3 p;","  vec3 ahead;","  float arc = 0.0;","  if(uState == 1) {","    p = aShape;","    p += vec3(sin(uTime*0.72+aPhase),cos(uTime*0.49+aPhase*1.7),","              sin(uTime*0.55+aPhase*0.6))*0.028*uMotion;","    ahead = p;","    float wave = pow(max(0.0,sin(aShape.x*1.6-uTime*3.1+aSeed*0.8)),12.0);","    vAlpha = 0.448+wave*1.12*uMotion;","  } else {","    p = flight(k); ahead = flight(min(1.0,k+0.012));","    arc = sin(k*3.14159265);","    vAlpha = uState == 0 ? 0.24+smoothstep(0.0,0.78,k)*0.76 : 1.0-smoothstep(0.72,1.0,k);","  }","  vec4 mv = modelViewMatrix*vec4(p,1.0);","  vec4 clip = projectionMatrix*mv;","  vec4 next = projectionMatrix*modelViewMatrix*vec4(ahead,1.0);","  vec2 velocity = next.xy/max(0.001,abs(next.w))-clip.xy/max(0.001,abs(clip.w));","  vDirection = length(velocity)>0.00001 ? normalize(velocity) : vec2(1.0,0.0);","  vStretch = uState == 1 ? 1.0 : 1.0+(2.0+arc*5.0)*uMotion;","  float tw = 1.0+uTwinkle*sin(uTime*1.9+aPhase)*0.35;","  float boost = 1.0+(uBoost-1.0)*(0.55+aShine*0.45);","  vec3 wn = normalize(mat3(modelMatrix)*aNormal);","  float wrap = dot(wn,uKeyDir)*0.5+0.5;","  float fill = dot(wn,normalize(vec3(-0.55,0.15,-0.65)))*0.5+0.5;","  vec3 vn = normalize(mat3(viewMatrix)*wn);","  float rim = pow(1.0-abs(vn.z),2.0);","  vLight = mix(1.0,0.20+0.96*wrap*wrap+0.28*fill,uLit)*(0.64+0.36*clamp(aShine,0.0,1.0));","  vRim = rim*uLit;","  float size = uState == 1 ? 0.34+aShine*0.95 : (0.35+aShine*0.65)*(1.0+arc*1.8*uMotion);","  float near = clamp((p.z+0.9)/1.8,0.0,1.0);","  size *= 0.74+0.34*near;","  vDepth = near;","  gl_PointSize = clamp(size*tw*boost*(54.0/max(1.0,-mv.z))*uPixelRatio,0.6,40.0);","  vShine = aShine; vCore = clamp(aShine,0.0,1.0);","  gl_Position = clip;","}"].join(`
`),NT=["precision mediump float;","uniform vec3 uAccent;","uniform vec3 uBody;","uniform vec3 uRim;","uniform float uAccentMix;","varying float vAlpha;","varying float vShine;","varying float vCore;","varying float vLight;","varying float vRim;","varying float vDepth;","varying vec2 vDirection;","varying float vStretch;","void main() {","  vec2 q = gl_PointCoord-vec2(0.5);","  vec2 dir = vec2(vDirection.x,-vDirection.y);","  float along = dot(q,dir);","  float across = dot(q,vec2(-dir.y,dir.x));","  float d = length(vec2(along,across*vStretch));","  float halo = exp(-d*d*15.0)*0.34;","  float core = exp(-d*d*240.0);","  float tail = mix(1.0,smoothstep(-0.5,0.15,along),clamp(vStretch-1.0,0.0,1.0));","  float a = min(1.0,halo+core)*vAlpha*(0.45+tail*0.25);","  a *= 0.52+0.78*vDepth;","  vec3 base = mix(uBody,uRim,vCore);","  vec3 col = mix(base,uAccent,clamp((vShine-0.9)*1.2,0.0,uAccentMix));","  col *= vLight;","  col = mix(col,uRim,clamp(vRim*0.55,0.0,0.6));","  col *= 0.82+0.24*vDepth;","  col += core*vCore*0.3*vLight;","  gl_FragColor = vec4(col,a);","}"].join(`
`),FT=["attribute float aSize;","attribute vec3 aColor;","attribute float aPhase;","attribute float aAlpha;","uniform float uTime;","uniform float uPixelRatio;","uniform float uSizeScale;","uniform float uAlpha;","uniform float uTwinkle;","uniform vec3 uTint;","varying vec3 vColor;","varying float vAlpha;","void main() {","  vColor = aColor*uTint;","  vec4 mv = modelViewMatrix * vec4(position, 1.0);","  float breath = sin(uTime*(0.34+0.12*sin(aPhase))+aPhase);","  float tw = 1.0-uTwinkle*0.24+uTwinkle*0.34*breath;","  gl_PointSize = clamp(aSize * uSizeScale * tw * (1.0 / max(1.0, -mv.z)) * uPixelRatio, 1.0, 512.0);","  vAlpha = aAlpha * tw * uAlpha;","  gl_Position = projectionMatrix * mv;","}"].join(`
`),UT=["precision mediump float;","varying vec3 vColor;","varying float vAlpha;","void main() {","  vec2 q = gl_PointCoord - vec2(0.5);","  float d = length(q);","  float halo = smoothstep(0.5, 0.0, d);","  float a = halo * halo * vAlpha;","  gl_FragColor = vec4(vColor, a);","}"].join(`
`),BT=["attribute float aSize;","attribute float aBright;","attribute float aPhase;","attribute float aRunner;","attribute vec3 aTarget;","uniform float uTime;","uniform float uPixelRatio;","uniform float uSizeScale;","uniform float uBrightness;","uniform float uTwinkle;","uniform float uFlow;","varying float vBright;","void main() {","  float runner = step(0.5,aRunner);","  float progress = fract((uTime-2.15)*0.2-(aRunner-1.0)*0.073);","  vec3 p = mix(position,aTarget,progress*runner);","  vec4 mv = modelViewMatrix * vec4(p, 1.0);","  float breath = sin(uTime*(0.42+0.09*sin(aPhase))+aPhase);","  float flare = pow(max(0.0,breath),8.0);","  float tw = 1.0+uTwinkle*(0.20*breath+0.10*flare);","  gl_PointSize = clamp(aSize * uSizeScale * tw * (1.0 / max(1.0, -mv.z)) * uPixelRatio, 1.0, 320.0);","  vBright = aBright*uBrightness*(1.0+uTwinkle*(0.27*sin(uTime*0.44+aPhase)+0.16*flare));","  vBright *= mix(1.0,uFlow*smoothstep(0.0,0.08,progress)*(1.0-smoothstep(0.92,1.0,progress)),runner);","  gl_Position = projectionMatrix * mv;","}"].join(`
`),OT=["precision highp float;","uniform vec3 uColor;","varying float vBright;","void main() {","  vec2 q = gl_PointCoord - vec2(0.5);","  float r = length(q);","  float ax = abs(q.x);","  float ay = abs(q.y);","  float core = exp(-r * r * 96.0);","  float sx = exp(-ax * ax * 1300.0 - ay * ay * 20.0);","  float sy = exp(-ay * ay * 1300.0 - ax * ax * 20.0);","  float halo = exp(-r * r * 13.0) * 0.32;","  float spike = sx + sy;","  float a = clamp((core + spike * 0.60 + halo) * vBright, 0.0, 1.0);","  vec3 col = mix(uColor, vec3(1.0), clamp(core * 1.3 + spike * 0.55, 0.0, 1.0));","  gl_FragColor = vec4(col * clamp(vBright, 0.0, 1.4), a);","}"].join(`
`);function zT(i){return new i.ShaderMaterial({uniforms:{uTime:{value:0},uPixelRatio:{value:1},uBoost:{value:1},uTwinkle:{value:1},uState:{value:0},uMotion:{value:1},uSpin:{value:1},uStagger:{value:.48},uSpinRate:{value:1},uArcScale:{value:1},uVariant:{value:0},uK:{value:0},uLit:{value:1},uKeyDir:{value:new i.Vector3(-.45,.52,.72).normalize()},uAccent:{value:new i.Color("#b9d3ff")},uBody:{value:new i.Color(1,1,1)},uRim:{value:new i.Color(1,1,1)},uAccentMix:{value:0}},vertexShader:DT,fragmentShader:NT,transparent:!0,depthWrite:!1,depthTest:!1,blending:i.AdditiveBlending})}function Md(i){return new i.ShaderMaterial({uniforms:{uTime:{value:0},uPixelRatio:{value:1},uSizeScale:{value:1},uAlpha:{value:1},uTwinkle:{value:1},uTint:{value:new i.Color(1,1,1)}},vertexShader:FT,fragmentShader:UT,transparent:!0,depthWrite:!1,depthTest:!1,blending:i.AdditiveBlending})}function jx(i,e){return new i.ShaderMaterial({uniforms:{uTime:{value:0},uPixelRatio:{value:1},uSizeScale:{value:1},uBrightness:{value:1},uTwinkle:{value:1},uFlow:{value:1},uColor:{value:new i.Color(e)}},vertexShader:BT,fragmentShader:OT,transparent:!0,depthWrite:!1,depthTest:!1,blending:i.AdditiveBlending})}var d0={low:3,medium:5,high:7},kT=["attribute vec3 aOrigin;","attribute vec3 aDir;","attribute vec2 aCorner;","attribute float aLen;","attribute float aWidth;","attribute float aPhase;","attribute float aPeriod;","attribute float aBright;","uniform float uTime;","uniform float uAlpha;","varying float vAlong;","varying float vAcross;","varying float vAlpha;","void main() {","  float elapsed = mod(uTime-aPhase,aPeriod);","  float t = clamp(elapsed/1.25,0.0,1.0);","  vec3 head = aOrigin+aDir*(aLen*(t*0.94));","  vec3 tail = head-aDir*(aLen*0.30);","  vec4 h = modelViewMatrix*vec4(head,1.0);","  vec4 b = modelViewMatrix*vec4(tail,1.0);","  vec2 direction = h.xy/max(0.001,-h.z)-b.xy/max(0.001,-b.z);","  vec2 side = vec2(direction.y,-direction.x)/max(length(direction),0.00001);","  vec4 p = mix(h,b,aCorner.x);","  p.xy += side*aWidth*aCorner.y*mix(1.0,0.12,aCorner.x);","  vAlong = aCorner.x;","  vAcross = aCorner.y;","  float fade = smoothstep(0.0,0.12,t)*(1.0-smoothstep(0.65,1.0,t));","  vAlpha = uAlpha*aBright*fade*step(aPhase,uTime);","  gl_Position = projectionMatrix*p;","}"].join(`
`),GT=["precision mediump float;","uniform vec3 uColor;","varying float vAlong;","varying float vAcross;","varying float vAlpha;","void main() {","  float taper = pow(clamp(1.0-vAlong,0.0,1.0),2.4);","  float head = exp(-vAlong*vAlong*260.0)*0.85;","  float edge = 1.0-smoothstep(0.15,1.0,abs(vAcross));","  float a = (taper*0.55+head)*edge*vAlpha;","  gl_FragColor = vec4(uColor*(0.72+head*0.6),a);","}"].join(`
`);function Sd(i,e,t){let n=new i.BufferGeometry;return n.setAttribute("position",new i.BufferAttribute(e,3)),n.setAttribute("aColor",t.color),n.setAttribute("aSize",t.size),n.setAttribute("aPhase",t.phase),n.setAttribute("aAlpha",t.alpha),n}function bd(i,e,t,n,r){return{color:new i.BufferAttribute(e,3),size:new i.BufferAttribute(t,1),phase:new i.BufferAttribute(n,1),alpha:new i.BufferAttribute(r,1)}}function Qx(i,e,t,n,r){let s=new i.BufferGeometry;return s.setAttribute("position",new i.BufferAttribute(e,3)),s.setAttribute("aSize",new i.BufferAttribute(t,1)),s.setAttribute("aBright",new i.BufferAttribute(n,1)),s.setAttribute("aPhase",r),s.setAttribute("aRunner",new i.BufferAttribute(new Float32Array(t.length),1)),s.setAttribute("aTarget",new i.BufferAttribute(new Float32Array(e.length),3)),s}function ey(i,e,t){let n=_d[t.quality]?t.quality:"high",r=_d[n],s=TT[n],o=AT[n],a=ET[n],l=n==="low",c=[];t.scope&&(c.push=(...Y)=>(Y.forEach(ve=>t.scope.track(ve)),Array.prototype.push.apply(c,Y)));let u=n;function f(Y){u=_d[Y]?Y:n,z.setDrawRange(0,Math.min(Ee,d0[u])*6),e.traverse(ve=>{if(!ve.isPoints||!ve.geometry)return;let Le=ve.geometry.getAttribute("position").count;ve.geometry.setDrawRange(0,Math.max(1,Math.floor(Le*Math.min(1,_d[u]/r))))})}let h=new i.SphereGeometry(140,l?40:64,l?26:40),d=LT(i,l?512:n==="medium"?1024:2048),p=new i.Mesh(h,d);p.frustumCulled=!1,p.renderOrder=-1e3,e.add(p),c.push(h,d,d.uniforms.uGalaxy.value);let v=new i.Group;e.add(v);let g=new i.Vector3(.52,.84,.16).normalize(),m=new i.Vector3(.84,-.52,0).normalize(),y=new i.Vector3().crossVectors(g,m),_=new i.Matrix4().makeBasis(m,g,y),x=Nn("zodiac-field-3"),S=new Float32Array(o*3),b=new Float32Array(o*3),E=new Float32Array(o),M=new Float32Array(o),T=new Float32Array(o);for(let Y=0;Y<o;Y+=1){let Le=x()<.64?(x()+x()+x()-1.5)*.23-.2:x()*2-1,ge=x()*Math.PI*2,qe=65+x()*35,$e=Math.sqrt(1-Le*Le);S[Y*3]=Math.cos(ge)*$e*qe,S[Y*3+1]=Le*qe,S[Y*3+2]=Math.sin(ge)*$e*qe;let tt=.62+x()*.38,st=x();b[Y*3]=tt*(st>.9?1:st<.12?.8:.96),b[Y*3+1]=tt*(st>.9?.88:.96),b[Y*3+2]=tt*(st>.9?.7:1),E[Y]=.55+Math.pow(x(),5)*2.8,M[Y]=x()*Math.PI*2,T[Y]=.18+Math.pow(x(),1.8)*.72}let A=Sd(i,S,bd(i,b,E,M,T));A.applyMatrix4(_);let I=Md(i);I.uniforms.uSizeScale.value=96;let D=new i.Points(A,I);D.frustumCulled=!1,D.renderOrder=-900,v.add(D),c.push(A,I);let B=Nn("zodiac-nebula-3"),F=[[.26,.18,.29],[.29,.23,.25],[.19,.2,.27],[.26,.22,.29]],L=new Float32Array(ao*3),U=new Float32Array(ao*3),X=new Float32Array(ao),te=new Float32Array(ao),Z=new Float32Array(ao);for(let Y=0;Y<ao;Y+=1){let ve=(B()+B()+B()-1.5)*.2-.2,Le=B()*Math.PI*2,ge=30+B()*48,qe=Math.sqrt(1-ve*ve);L[Y*3]=Math.cos(Le)*qe*ge,L[Y*3+1]=ve*ge,L[Y*3+2]=Math.sin(Le)*qe*ge;let $e=F[Y%F.length],tt=.45+B()*.55;U[Y*3]=$e[0]*tt,U[Y*3+1]=$e[1]*tt,U[Y*3+2]=$e[2]*tt,X[Y]=70+B()*150,te[Y]=B()*Math.PI*2,Z[Y]=.01+B()*.025}let K=Sd(i,L,bd(i,U,X,te,Z));K.applyMatrix4(_);let j=Md(i);j.uniforms.uSizeScale.value=120;let ne=new i.Points(K,j);ne.frustumCulled=!1,ne.renderOrder=-890,v.add(ne),c.push(K,j);let ie=Nn("zodiac-sparkle-3"),We=new Float32Array(a*3),Fe=new Float32Array(a),Ye=new Float32Array(a),$=new Float32Array(a);for(let Y=0;Y<a;Y+=1){let ve=ie()*2-1,Le=ie()*Math.PI*2,ge=52+ie()*34,qe=Math.sqrt(1-ve*ve);We[Y*3]=Math.cos(Le)*qe*ge,We[Y*3+1]=ve*ge*.85,We[Y*3+2]=Math.sin(Le)*qe*ge,Fe[Y]=1.2+Math.pow(ie(),5)*4.8,Ye[Y]=.34+ie()*.66,$[Y]=ie()*Math.PI*2}let oe=Qx(i,We,Fe,Ye,new i.BufferAttribute($,1)),Ce=jx(i,"#f2f0eb");Ce.uniforms.uSizeScale.value=260;let He=new i.Points(oe,Ce);He.frustumCulled=!1,He.renderOrder=-880,v.add(He),c.push(oe,Ce);let Ee=d0[n]||d0.high,ze=Nn("zodiac-meteors-1"),pt=new Float32Array(Ee*6*3),ae=new Float32Array(Ee*6*3),xe=new Float32Array(Ee*6*3),we=new Float32Array(Ee*6*2),Ae=new Float32Array(Ee*6),Te=new Float32Array(Ee*6),de=new Float32Array(Ee*6),Oe=new Float32Array(Ee*6),Re=new Float32Array(Ee*6),Je=[[0,-1],[1,-1],[1,1],[0,-1],[1,1],[0,1]];for(let Y=0;Y<Ee;Y+=1){let ve=(ze()*2-1)*.55,Le=-Math.PI/2+Y*2.399963+(ze()-.5)*.4,ge=62+ze()*24,qe=Math.sqrt(1-ve*ve),$e=Math.cos(Le)*qe*ge,tt=ve*ge*.8,st=Math.sin(Le)*qe*ge,It=new i.Vector3($e,tt,st).normalize(),ke=new i.Vector3(-Math.sin(Le),0,Math.cos(Le)),wt=.25+ze()*.4,ut=ke.addScaledVector(new i.Vector3().crossVectors(It,ke),wt).normalize().toArray(),Tt=6+ze()*9,Ot=.05+ze()*.035,rn=Y===0?2+ze()*4:4+ze()*32,Un=17+ze()*19,xt=.34+ze()*.34;for(let St=0;St<6;St+=1){let yt=Y*6+St;ae.set([$e,tt,st],yt*3),xe.set(ut,yt*3),we.set(Je[St],yt*2),Ae[yt]=Tt,Te[yt]=Ot,de[yt]=rn,Oe[yt]=Un,Re[yt]=xt}}let z=new i.BufferGeometry;z.setAttribute("position",new i.BufferAttribute(pt,3)),z.setAttribute("aOrigin",new i.BufferAttribute(ae,3)),z.setAttribute("aDir",new i.BufferAttribute(xe,3)),z.setAttribute("aCorner",new i.BufferAttribute(we,2)),z.setAttribute("aLen",new i.BufferAttribute(Ae,1)),z.setAttribute("aWidth",new i.BufferAttribute(Te,1)),z.setAttribute("aPhase",new i.BufferAttribute(de,1)),z.setAttribute("aPeriod",new i.BufferAttribute(Oe,1)),z.setAttribute("aBright",new i.BufferAttribute(Re,1)),z.setDrawRange(0,Ee*6);let lt=new i.ShaderMaterial({uniforms:{uTime:{value:0},uAlpha:{value:.55},uColor:{value:new i.Color(.78,.86,1)}},vertexShader:kT,fragmentShader:GT,transparent:!0,depthWrite:!1,depthTest:!1,blending:i.AdditiveBlending}),rt=new i.Mesh(z,lt);rt.frustumCulled=!1,rt.renderOrder=-885,v.add(rt),c.push(z,lt);let P=new i.Group;e.add(P);let w=new i.Group;P.add(w);let q=new i.Group;q.add(new i.AmbientLight("#b4b4c5",.65));let J=new i.DirectionalLight("#fff4e3",3.2);J.position.set(-5,6,8),q.add(J);let G=new i.DirectionalLight("#c4daf1",2.4);G.position.set(4,1,-5),q.add(G);let re=new i.DirectionalLight("#e0cadb",1.1);re.position.set(5,-3,4),q.add(re),e.add(q);let Q=zT(i),V=new i.MeshStandardMaterial({color:new i.Color("#ffffff"),emissive:new i.Color("#000000"),emissiveIntensity:.35,roughness:.42,metalness:.18,flatShading:!0,vertexColors:!0,transparent:!0,opacity:.005,side:i.DoubleSide,depthTest:!0,depthWrite:!1,toneMapped:!1}),ee=(Y,ve)=>new i.MeshBasicMaterial({color:new i.Color(Y),transparent:!0,opacity:ve,side:i.DoubleSide,depthTest:!1,depthWrite:!1,blending:i.AdditiveBlending,toneMapped:!1}),le=ee("#ffffff",.28),Se=ee("#ffffff",.075),me=Md(i);me.uniforms.uSizeScale.value=52;let _e=ee("#ffffff",.2),ce=ee("#ffffff",.9),fe=Md(i);fe.uniforms.uSizeScale.value=120;let De=jx(i,"#ffffff");De.uniforms.uSizeScale.value=300,c.push(Q,V,le,Se,me,_e,ce,fe,De);let O=new i.Color("#ffffff"),Me=CT.map(([Y,ve])=>{let Le=new i.Color(Y),ge=new i.Color(ve);return{body:Le,glow:ge,emissive:Le.clone().multiplyScalar(.18),edge:Le.clone().lerp(O,.55),core:ge.clone().lerp(O,.82),particle:Le.clone().lerp(ge,.2).convertLinearToSRGB(),particleRim:Le.clone().lerp(ge,.55).convertLinearToSRGB(),haze:Le.clone().lerp(ge,.35).convertLinearToSRGB(),node:ge.clone().lerp(O,.5).convertLinearToSRGB(),star:ge.clone().lerp(O,.3).convertLinearToSRGB()}}),se=yd(r),Pe=new Float32Array(r);for(let Y=0;Y<r;Y+=1)Pe[Y]=se[Y]*Math.PI*2;let Be=new i.BufferAttribute(Pe,1),ue=new i.BufferAttribute(se,1),je=(()=>{let Y=Nn("zodiac-haze-1"),ve=new Float32Array(s*3),Le=new Float32Array(s),ge=new Float32Array(s),qe=new Float32Array(s);for(let $e=0;$e<s;$e+=1){let tt=.55+Y()*.45;ve[$e*3]=ve[$e*3+1]=ve[$e*3+2]=tt,Le[$e]=1.1+Math.pow(Y(),2.4)*3,ge[$e]=Y()*Math.PI*2,qe[$e]=.006+Y()*.016}return bd(i,ve,Le,ge,qe)})(),Ze=(()=>{let Y=Nn("zodiac-disc-1"),ve=new Float32Array(Lu);for(let Le=0;Le<Lu;Le+=1)ve[Le]=Y()*Math.PI*2;return new i.BufferAttribute(ve,1)})(),Mt=(()=>{let Y=Nn("zodiac-node-1"),ve=new Float32Array(lr*3),Le=new Float32Array(lr),ge=new Float32Array(lr),qe=new Float32Array(lr);for(let $e=0;$e<lr;$e+=1){let tt=.7+Y()*.3;ve[$e*3]=ve[$e*3+1]=ve[$e*3+2]=tt,Le[$e]=.3+Math.pow(Y(),1.8)*.55,ge[$e]=Y()*Math.PI*2,qe[$e]=.25+Y()*.35}return bd(i,ve,Le,ge,qe)})(),ct=[],Vt=[],kt=[],ni=[],ii=[],Hi=[],Wi=[],ri=[],vi=[],cr=[],Yn=[];for(let Y=0;Y<Ct;Y+=1){let ve=gd(Y,r),Le=[Iu(Fn[Y].id,r),Iu(Fn[(Y+1)%Ct].id,r)],ge=xd(Y,s),qe=vd(Y);Yn.push(ge),cr.push(qe);let $e=new i.BufferGeometry;$e.setAttribute("position",new i.BufferAttribute(new Float32Array(r*3),3)),$e.setAttribute("aEntry",new i.BufferAttribute(Le[0],3)),$e.setAttribute("aShape",new i.BufferAttribute(ve.pos,3)),$e.setAttribute("aExit",new i.BufferAttribute(Le[1],3)),$e.setAttribute("aNormal",new i.BufferAttribute(ve.normals,3)),$e.setAttribute("aShine",new i.BufferAttribute(ve.shine,1)),$e.setAttribute("aPhase",Be),$e.setAttribute("aSeed",ue),ct.push($e),c.push($e);let tt=Sd(i,ge.cloud,je);Vt.push(tt),c.push(tt);let st=new i.BufferGeometry;st.setAttribute("position",new i.BufferAttribute(ge.mesh.pos,3)),st.setAttribute("color",new i.BufferAttribute(ge.mesh.tint,3)),st.computeVertexNormals(),kt.push(st),c.push(st);let It=new i.BufferGeometry;It.setAttribute("position",new i.BufferAttribute(ge.contourCore,3)),ni.push(It);let ke=new i.BufferGeometry;ke.setAttribute("position",new i.BufferAttribute(ge.contourHalo,3)),ii.push(ke);let wt=Sd(i,ge.nodes,Mt);Hi.push(wt),c.push(It,ke,wt);let ut=new i.BufferGeometry;ut.setAttribute("position",new i.BufferAttribute(qe.halo,3)),Wi.push(ut);let Tt=new i.BufferGeometry;Tt.setAttribute("position",new i.BufferAttribute(qe.core,3)),ri.push(Tt),c.push(ut,Tt);let Ot=new Float32Array(Lu*3),rn=new Float32Array(Lu),Un=new Float32Array(Lu),xt=Math.min(qe.nodes,wd);for(let yt=0;yt<xt;yt+=1)Ot[yt*3]=qe.x[yt],Ot[yt*3+1]=qe.y[yt],Ot[yt*3+2]=qe.z[yt],rn[yt]=.55+qe.m[yt]*1.75,Un[yt]=.55+qe.m[yt]*.85;let St=Qx(i,Ot,rn,Un,Ze);Wa[Y].lines.forEach(([yt,nt],Xt)=>{let qt=wd+Xt;Ot.set([qe.x[yt],qe.y[yt],qe.z[yt]],qt*3),St.getAttribute("aTarget").array.set([qe.x[nt],qe.y[nt],qe.z[nt]],qt*3),St.getAttribute("aRunner").array[qt]=Xt+1,rn[qt]=.6,Un[qt]=.7}),St.setDrawRange(0,wd+qe.segments),vi.push(St),c.push(St)}let Ci=new i.Points(ct[0],Q);Ci.frustumCulled=!1,Ci.renderOrder=-10,P.add(Ci);let xi=new i.Points(Vt[0],fe);xi.frustumCulled=!1,xi.renderOrder=-100,w.add(xi);let Xi=new i.Mesh(kt[0],V);Xi.frustumCulled=!1,Xi.renderOrder=-90,w.add(Xi);let Zn=new i.Mesh(ii[0],Se),qi=new i.Mesh(ni[0],le),yi=new i.Points(Hi[0],me);Zn.frustumCulled=!1,qi.frustumCulled=!1,yi.frustumCulled=!1,Zn.renderOrder=-82,qi.renderOrder=-80,yi.renderOrder=-78,w.add(Zn),w.add(qi),w.add(yi);let Ri=new i.Mesh(Wi[0],_e),ur=new i.Mesh(ri[0],ce);Ri.frustumCulled=!1,ur.frustumCulled=!1,Ri.renderOrder=10,ur.renderOrder=11,w.add(Ri),w.add(ur);let Yi=new i.Points(vi[0],De);Yi.frustumCulled=!1,Yi.renderOrder=12,w.add(Yi);let Bt=-1,ho=0,us=!0,Tn=1;function C(Y){let ve=(Y%Ct+Ct)%Ct;if(ve===Bt)return Fn[ve];Bt=ve;let Le=Me[ve];return V.color.copy(Le.body),V.emissive.copy(Le.emissive),le.color.copy(Le.edge),Se.color.copy(Le.glow),ce.color.copy(Le.core),_e.color.copy(Le.glow),Q.uniforms.uBody.value.copy(Le.particle),Q.uniforms.uRim.value.copy(Le.particleRim),fe.uniforms.uTint.value.copy(Le.haze),me.uniforms.uTint.value.copy(Le.node),De.uniforms.uColor.value.copy(Le.star),Ci.geometry=ct[ve],xi.geometry=Vt[ve],Xi.geometry=kt[ve],Zn.geometry=ii[ve],qi.geometry=ni[ve],yi.geometry=Hi[ve],Ri.geometry=Wi[ve],ur.geometry=ri[ve],Yi.geometry=vi[ve],f(u),Fn[ve]}function H(Y){Q.uniforms.uPixelRatio.value=Y,[I,j,fe,me].forEach(ve=>{ve.uniforms.uPixelRatio.value=Y}),Ce.uniforms.uPixelRatio.value=Y,De.uniforms.uPixelRatio.value=Y}function N(Y){!Y||!Y.accent||(Q.uniforms.uAccent.value.set(Y.accent).convertLinearToSRGB(),Q.uniforms.uAccentMix.value=.1)}function k(Y){let ve=qn(Y);return ve*ve*(3-2*ve)}function W(Y,ve){return Y==="gather"?k((ve-.42)/.5):Y==="disperse"?1-k(ve/.62):1}function ye(Y,ve){let Le=ve||{};ho=Le.cycle||0;let ge=!!Le.reduced,qe=Le.state||"hold",$e=Le.k||0,tt=Le.bass||0,st=Le.onset||0;Q.uniforms.uTime.value=Y,Q.uniforms.uBoost.value=1+tt*.6+st*.8,Q.uniforms.uTwinkle.value=ge?.15:1;let It=ge?0:Math.sin(Y*.11)*.34,ke=ge?.52:.44+Math.sin(Y*.067+.8)*.14;Q.uniforms.uKeyDir.value.set(Math.sin(-.62+It)*Math.cos(ke),Math.sin(ke),Math.cos(-.62+It)*Math.cos(ke)).normalize(),Q.uniforms.uState.value=qe==="gather"?0:qe==="disperse"?2:1,Q.uniforms.uK.value=$e;let wt=Pu(Le.cycle||0,Bt<0?0:Bt);Q.uniforms.uVariant.value=qe==="disperse"?wt.disperse:wt.gather,Q.uniforms.uSpin.value=wt.direction,Q.uniforms.uStagger.value=wt.stagger,Q.uniforms.uSpinRate.value=wt.spin,Q.uniforms.uArcScale.value=wt.arc,Q.uniforms.uMotion.value=ge?.12:1;let ut=ge?.2:1;I.uniforms.uTime.value=Y,I.uniforms.uTwinkle.value=ut,j.uniforms.uTime.value=Y,j.uniforms.uTwinkle.value=ut*.35,Ce.uniforms.uTime.value=Y,Ce.uniforms.uTwinkle.value=ut,Ce.uniforms.uBrightness.value=.82+st*.3,lt.uniforms.uTime.value=Y,lt.uniforms.uAlpha.value=ge?0:.55,rt.visible=!ge;let Tt=ge?.06:.46;P.rotation.y=Math.sin(Y*.3)*Tt+Math.sin(Y*.085+1.3)*Tt*.42,P.rotation.x=Math.sin(Y*.19)*(ge?0:.16)+Math.cos(Y*.075+.5)*(ge?0:.05);let Ot=1+st*.02+tt*.012;P.scale.setScalar(qe==="gather"?Ot*(.92+$e*.08):Ot),Tn=W(qe,$e),fe.uniforms.uAlpha.value=Tn,fe.uniforms.uTime.value=Y,V.opacity=.016*Tn,le.opacity=.28*Tn,Se.opacity=(.075+tt*.035)*Tn,me.uniforms.uAlpha.value=Tn*.045,me.uniforms.uTime.value=Y,me.uniforms.uTwinkle.value=ge?.25:1,ce.opacity=(.9+tt*.06)*Tn,_e.opacity=(.2+tt*.16)*Tn,De.uniforms.uBrightness.value=Tn*(1+st*.35),De.uniforms.uTime.value=Y,De.uniforms.uTwinkle.value=ge?.25:1,De.uniforms.uFlow.value=ge?.2:1,w.visible=Tn>.002,v.rotation.y=Y*(ge?0:.0022),v.position.copy(Le.cameraPos||{x:0,y:0,z:0}),p.rotation.y=v.rotation.y,p.position.copy(v.position)}function Ie(Y){us=!!Y,v.visible=us}function Ue(){return{signIndex:Bt<0?0:Bt,sign:Bt<0?null:Fn[Bt].id,signCn:Bt<0?null:Fn[Bt].cn,signEn:Bt<0?null:Fn[Bt].en,particleCount:r,fieldPoints:o+ao+a,fieldVisible:us,figureTriangles:Bt<0?0:Yn[Bt].triangles,figureEdges:Bt<0?0:Yn[Bt].segmentCount,figurePoints:s,figureMeshPoints:lr,constellationNodes:Bt<0?0:cr[Bt].nodes,constellationSegments:Bt<0?0:cr[Bt].segments,figureAlpha:Math.round(Tn*1e3)/1e3,sky:!0,layers:14,meteorCount:z.drawRange.count/6,transition:{...Pu(ho,Bt<0?0:Bt)}}}function Ne(){t.scope||c.forEach(Y=>{Y.dispose()}),e.remove(P),e.remove(v),e.remove(p),e.remove(q)}return Ie(!0),{setSign:C,update:ye,dispose:Ne,stats:Ue,setPalette:N,setPixelRatio:H,setFieldVisible:Ie,setQuality:f}}var VT={low:{prCap:1,budget:19e5},medium:{prCap:1.15,budget:36e5},high:{prCap:1.55,budget:62e5}},p0=24;var HT="#030405",ty=1.3,Du=52,WT=2.6,XT=18,qT=.42,iy=2.4;function Td(i){let e=Math.tan(Du*Math.PI/180/2),t=i>.01?i:oo;return Math.max(Va*ty/e,Ru*ty/(e*t))}function ry(i){return qn(i.distFit*i.zoom,WT,Math.max(XT,i.distFit*iy))}var ny=.75,YT=.035;function ZT(i,e={},t=null){let n=VT[e.quality]?e.quality:"high",r=t&&t.renderer;try{r||(r=new Lr({canvas:i,antialias:!0,powerPreference:"high-performance"}))}catch{return!1}if(!r.getContext())return!1;r.outputColorSpace=nn,r.toneMapping=Mn,r.info.autoReset=!1;let s=t?t.scene:new li;s.background=new be(HT);let o=t?t.camera:new Ft(Du,1,.1,400);Object.assign(o,{fov:Du,near:.1,far:400}),o.position.set(0,0,Td(oo));let a=o.clone(),l={field:!0,interactive:e.interactive!==!1,glow:1,speed:1,reduced:!!e.reduced,palette:e.palette||{}},c=ey(fi,s,{quality:t?"high":n,scope:t&&t.scope});t&&t.scope.defer(()=>c.dispose()),c.setPalette(l.palette);let u={raw:null,onset:!1,bins:new Float32Array(p0),target:new Float32Array(p0),bass:0,onsetLevel:0},f={drift:0,yaw:0,pitch:.06,zoom:1,distFit:Td(oo),dist:Td(oo),dragging:!1,fov:Du};function h(){f.dist=ry(f)}function d(S){if(l.interactive){f.dragging=!0;try{i.setPointerCapture(S.pointerId)}catch{}}}function p(S){!l.interactive||!f.dragging||!(S.buttons&1)||(f.yaw-=S.movementX*.008,f.pitch=qn(f.pitch+S.movementY*.006,-ny,ny))}function v(){f.dragging=!1}function g(S){l.interactive&&(S.preventDefault(),f.zoom=f0(f.zoom*(1+S.deltaY*.001),qT,iy),h())}function m(){l.interactive&&(f.yaw=0,f.pitch=.06,f.zoom=1,h())}function y(){i.addEventListener("pointerdown",d),i.addEventListener("pointermove",p),window.addEventListener("pointerup",v),i.addEventListener("wheel",g,{passive:!1}),i.addEventListener("dblclick",m),i.style.touchAction=l.interactive?"none":""}function _(){i.removeEventListener("pointerdown",d),i.removeEventListener("pointermove",p),window.removeEventListener("pointerup",v),i.removeEventListener("wheel",g),i.removeEventListener("dblclick",m),i.style.touchAction=""}return{canvas:i,renderer:r,scene:s,camera:o,cameraTarget:a,control:null,world:c,quality:n,prefs:l,audio:u,rig:f,raf:0,lastFrame:0,lastRender:0,lastTime:-1,time:0,sceneTime:0,playing:!1,dirty:!0,width:0,height:0,pr:1,timeline:{index:-1,state:"gather",t:0},warmed:!!t,bindInput:y,unbindInput:_}}function $T(i){let e=i.timeline.index>=0?i.timeline.index:0;for(let t=0;t<Ct;t+=1)i.world.setSign(t),i.renderer.render(i.scene,i.camera);i.world.setSign(e),i.renderer.info.reset()}function JT(i,e,t){let n=t===void 0?i.lastFrame?Math.min((e-i.lastFrame)/1e3,i.playing?.1:.25):.016:t;i.lastFrame=e;let r=i.prefs,s=i.time,o=i.lastTime<0||Math.abs(s-i.lastTime)>.5;i.lastTime=s,!i.warmed&&i.width>0&&(i.warmed=!0,$T(i));let a=$m(i.playing?i.audio.raw:null,p0,i.audio.target);o?i.audio.bins.set(a):Bx(i.audio.bins,a,n);let l=h0(i.audio.bins);o||!i.playing?i.audio.bass=o?l:za(i.audio.bass,0,.3,n):i.audio.bass=za(i.audio.bass,l,.1,n);let c=i.playing&&i.audio.onset?1:0;i.audio.onsetLevel=o?c:za(i.audio.onsetLevel||0,c,c?.05:.22,n),(!r.reduced||o)&&(i.sceneTime=s);let u=u0(i.sceneTime);i.timeline=u,i.world.setSign(u.index);let f=u.state==="gather"?qn(u.t/Ur):u.state==="disperse"?qn(u.t/Cu):1,h=i.rig,d=i.camera,p=!1;if(i.control){let v=i.cameraTarget,g=i.control.external?1:1-Math.exp(-n/.26);d.position.lerp(v.position,g),d.quaternion.slerp(v.quaternion,g),d.fov+=(v.fov-d.fov)*g,d.updateProjectionMatrix(),p=d.position.distanceToSquared(v.position)>1e-8||d.quaternion.angleTo(v.quaternion)>1e-4||Math.abs(d.fov-v.fov)>1e-4}else{h.drift+=n*YT*(r.reduced?.3:1)*r.speed+n*i.audio.bass*.04*(r.reduced?.3:1);let v=h.drift+h.yaw,g=Math.cos(h.pitch);d.position.set(Math.sin(v)*g*h.dist,Math.sin(h.pitch)*h.dist,Math.cos(v)*g*h.dist),d.lookAt(0,0,0);let m=Du+i.audio.bass*1.6;h.fov=o?m:za(h.fov,m,.32,n),Math.abs(d.fov-h.fov)>.001&&(d.fov=h.fov,d.updateProjectionMatrix())}i.world.update(i.sceneTime,{bass:i.audio.bass,onset:i.audio.onsetLevel,cycle:u.cycle,reduced:r.reduced,glow:r.glow,dt:n,state:u.state,k:f,cameraPos:d.position}),i.dirty=p,i.lastRender=e}function sy(i){let e=ZT(i.renderer.domElement,{quality:i.quality.mode,interactive:!1},i);if(!e)throw new Error("Zodiac world initialization failed");let t=!!i.params.reduced;return{update(n){e.prefs.reduced=t||!!n.reduced;let r=e.prefs.reduced||n.playing===!1;r||(e.time=Number(n.sceneTime??n.time)||0),e.playing=!!n.playing,e.audio.raw=n.bands||null,e.audio.onset=!r&&!!n.onset;let s=r?0:Math.max(0,Math.min(n.dynamicDt??n.dt??.016,.1));JT(e,Number(n.now)||0,s),e.prefs.sign>=0&&(e.world.setSign(e.prefs.sign),e.world.update(e.sceneTime,{bass:e.audio.bass,onset:e.audio.onsetLevel,cycle:0,reduced:e.prefs.reduced,glow:e.prefs.glow,dt:s,state:"hold",k:1,cameraPos:e.camera.position}))},resize(n,r){e.width=n,e.height=r,e.camera.aspect=n/r,e.camera.updateProjectionMatrix(),e.rig.distFit=Td(n/r),e.rig.dist=ry(e.rig),e.world.setPixelRatio(e.renderer.getPixelRatio())},setParams(n){e.prefs.glow=n.glow,e.prefs.speed=n.speed,t=!!n.reduced,e.prefs.reduced=t,e.prefs.sign=n.sign==="cycle"?-1:Fn.findIndex(r=>r.id===n.sign),e.world.setFieldVisible(n.field)},setQuality(n){e.world.setQuality(n.mode),e.world.setPixelRatio(e.renderer.getPixelRatio())},setRig(n){if(e.control=n,!n)return;let r=e.cameraTarget;if(n.position)r.position.fromArray(n.position),r.rotation.set(n.pitch,n.yaw,n.roll||0,"YXZ");else{let s=Math.cos(n.pitch);r.position.set(n.tx+Math.sin(n.yaw)*s*n.dist,n.ty+Math.sin(n.pitch)*n.dist,n.tz+Math.cos(n.yaw)*s*n.dist),r.lookAt(n.tx,n.ty,n.tz),r.rotateZ(n.roll||0)}r.fov=n.fov},dispose(){}}}var Ad={ZODIAC:Fn,SIGN_COUNT:Ct,GATHER_SECONDS:Ur,HOLD_SECONDS:Au-Ur-Cu,DISPERSE_SECONDS:Cu,CYCLE_SECONDS:Au,buildShape:gd,buildCloud:Iu,buildSeeds:yd,timelineAt:u0,transitionStyle:Pu,aggregateBands:$m,viewBass:h0,zoomClamp:f0,CONSTELLATION:Wa,buildFigureMesh:xd,buildConstellation:vd,buildRibbon:ls,delaunay2:Kx,shapeFit:Ha,FIG_HALF:Va,FIG_HALF_W:Ru,FIG_ASPECT:oo,FIGURE_DEPTH:md,SHAPE_BOX:qx,SHAPE_BOX_V:Yx,SHAPE_BOX_Z:Zx,CONSTELLATION_Z:r0,FIGURE_Z:Eu,FIGURE_MESH_POINTS:lr,LINE_CORE_WIDTH:s0,LINE_HALO_WIDTH:o0,EDGE_CORE_WIDTH:a0,EDGE_HALO_WIDTH:l0};var KT={"sans-serif":'"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',serif:'"Noto Serif CJK SC", "Songti SC", SimSun, serif'},oy=new Intl.Segmenter(void 0,{granularity:"grapheme"});function ay(i,e,t="sans-serif",n=1792){let r=String(e||"").slice(0,120).replace(/[\uD800-\uDBFF]$/,""),s=64,o=n<1792?6:4,a=112,l;do{i.font="600 "+a+"px "+(KT[t]||t),l=[];let h=0,d=0,p=-1;for(let{segment:v,index:g}of oy.segment(r))i.measureText(r.slice(h,g+v.length)).width>n&&g>h&&(d=p>h?p:g,l.push({start:h,end:d}),h=d,p=-1),/\s/.test(v)&&(p=g+v.length);if((h<r.length||!l.length)&&l.push({start:h,end:r.length}),l.length<=o||a<=32)break;a-=8}while(!0);let c=Math.ceil(a*1.42),u=c*l.length+s*2,f=Math.min(2048,Math.max(256,Math.ceil(Math.max(...l.map(h=>i.measureText(r.slice(h.start,h.end)).width))+s*2)));return l.forEach((h,d)=>{h.width=i.measureText(r.slice(h.start,h.end)).width,h.left=(f-h.width)/(2*f),h.right=1-h.left,h.baseline=s+c*(d+.5),h.bottom=1-(s+c*(d+1))/u,h.top=1-(s+c*d)/u,h.advances=new Float32Array(h.end-h.start+1);for(let{segment:p,index:v}of oy.segment(r.slice(h.start,h.end))){let g=i.measureText(r.slice(h.start,h.start+v)).width,m=i.measureText(r.slice(h.start,h.start+v+p.length)).width;for(let y=0;y<=p.length;y++)h.advances[v+y]=h.left+(g+(m-g)*y/p.length)/f}}),{text:r,width:f,height:u,padding:s,fontSize:a,font:i.font,rows:l}}function ly(i,e,t,n){let r=Math.max(0,Math.min(1,Number(n)||0))*i.text.length;if(e?.tokens?.length){r=0;let s=0;for(let o=0;o<Math.min(120,e.tokens.length);o++){let a=e.tokens[o],l=String(a.text||""),c=i.text.indexOf(l,s);if(c<0||!l)continue;let u=Number(a.start)||0,f=Math.max(u+.01,Number(a.end)||u+.1);if(t<u)break;let h=Math.max(0,Math.min(1,(t-u)/(f-u)));if(r=c+l.length*h,s=c+l.length,h<1)break;o===e.tokens.length-1&&(r=i.text.length)}}return i.rows.map(s=>{if(r<=s.start)return s.left-.02;if(r>=s.end)return s.right+.02;let o=r-s.start,a=Math.floor(o);return s.advances[a]+(s.advances[a+1]-s.advances[a])*(o-a)})}function Ei(i,e,t=n=>n){let n=!1,r=null,s=!1,o=new Map,a=new Map,l=[];function c(v,g){if(typeof document>"u")return null;let m=document.createElement("canvas");return m.width=v,m.height=g,m}function u(v,g,m){if(m.refs>0)return;let y=l.indexOf(m);y>=0&&l.splice(y,1),m.cancel?.(),m.texture?.dispose(),v.delete(g)}function f(v,g){for(let[m,y]of v){if(v.size<=g)break;u(v,m,y)}}function h(v,g){let m=v.get(g);m&&(m.refs=Math.max(0,m.refs-1),m.refs||u(v,g,m))}return{text:{acquire(v,g="sans-serif",m=1792){let y=String(v||"").slice(0,120).replace(/[\uD800-\uDBFF]$/,""),_=g+":"+m+":"+y,x=o.get(_);return!x&&o.size<7&&(x={key:_,line:y,font:g,maxWidth:m,refs:0,texture:null,aspect:8},o.set(_,x),l.push(x)),x?(x.refs++,x):null},release(v){v&&h(o,v.key)}},cover:{acquire(v,g){if(!v||n||g?.aborted)return null;let m=String(v),y=a.get(m);if(!y&&a.size<12&&(y={key:m,refs:0,texture:null,failed:!1},a.set(m,y),typeof Image<"u")){let _=new Image;_.crossOrigin="anonymous",_.decoding="async";let x=!1,S=()=>{x||n||g?.aborted||!y.refs||(y.failed=!0,e?.())};y.cancel=()=>{x=!0,_.onload=_.onerror=null,_.src=""},_.onload=()=>{if(x||n||g?.aborted||!y.refs)return;let b=c(768,768),E=b?.getContext("2d");if(!E){S();return}try{let M=Math.min(_.naturalWidth,_.naturalHeight);E.drawImage(_,(_.naturalWidth-M)/2,(_.naturalHeight-M)/2,M,M,0,0,768,768),y.texture=new i.CanvasTexture(b),y.texture.colorSpace=i.SRGBColorSpace,y.texture.userData.spaceShared=!0,y.texture.minFilter=i.LinearMipmapLinearFilter,e?.()}catch{S()}},_.onerror=S,Promise.resolve().then(()=>t(m)).then(b=>{x||n||g?.aborted||!y.refs||(b?_.src=b:S())}).catch(S)}return y?(y.refs++,y):null},release(v){v&&h(a,v.key)}},beginFrame(v){if(!n&&(r!==v&&(r=v,s=!1),!s)){for(;l.length;){let g=l.shift();if(!g.refs||!o.has(g.key))continue;let m=c(1,1),y=m?.getContext("2d");if(!y)break;let _=ay(y,g.line,g.font,g.maxWidth);m.width=_.width,m.height=_.height,y.font=_.font,g.layout=_,g.aspect=_.width/_.height,g.start=_.rows[0].left,g.end=_.rows[0].right,y.textAlign="center",y.textBaseline="middle",y.fillStyle="#ffffff",_.rows.forEach(x=>y.fillText(g.line.slice(x.start,x.end),_.width/2,x.baseline)),g.texture=new i.CanvasTexture(m),g.texture.generateMipmaps=!1,g.texture.userData.spaceShared=!0,g.texture.minFilter=i.LinearFilter,s=!0;break}f(o,7),f(a,12),l.length&&e?.()}},stats(){return{textTextures:o.size,coverTextures:a.size,queued:l.length,bytes:[...o.values()].reduce((v,g)=>v+(g.layout?g.layout.width*g.layout.height*4:0),0)+a.size*768*768*4*4/3}},dispose(){if(!n){n=!0;for(let v of[o,a]){for(let g of v.values())g.refs=0,g.cancel?.(),g.texture?.dispose();v.clear()}l.length=0}}}}function Xa(i,e,{surface:t=!1,depth:n=0,radius:r=1.25}={}){let s=i.THREE,o=new s.Raycaster,a=new s.Vector2,l=new s.Plane,c=new s.Vector3,u=new s.Vector3,f=new s.Vector3,h=new s.Matrix4,d={uPointer:{value:new s.Vector3},uPointerNormal:{value:new s.Vector3(0,0,1)},uPointerAmount:{value:0},uPointerRadius:{value:r}},p=null,v=!1;return{uniforms:d,update(g,m=1){let y=Number.isFinite(g.now)?g.now:0,_=p===null?1/60:Math.max(0,Math.min(.05,(y-p)/1e3));if(p=y,g.reduced){d.uPointerAmount.value=0,v=!1;return}let x=g.pointer,S=!1;x?.active&&Number.isFinite(x.x)&&Number.isFinite(x.y)&&(e.updateWorldMatrix(!0,!1),i.camera.updateMatrixWorld(),h.copy(e.matrixWorld).invert(),t?u.set(0,0,1).transformDirection(e.matrixWorld):i.camera.getWorldDirection(u).negate(),c.set(0,0,n).applyMatrix4(e.matrixWorld),l.setFromNormalAndCoplanarPoint(u,c),a.set(x.x,x.y),o.setFromCamera(a,i.camera),Math.abs(o.ray.direction.dot(u))>.15&&o.ray.intersectPlane(l,f)&&(f.applyMatrix4(h),S=!t||Math.abs(f.x)<4.5&&Math.abs(f.y)<4.5,S&&(v?d.uPointer.value.lerp(f,1-Math.exp(-32*_)):d.uPointer.value.copy(f),d.uPointerNormal.value.copy(u).transformDirection(h)))),v=S;let b=S?m:0;d.uPointerAmount.value+=(b-d.uPointerAmount.value)*(1-Math.exp(-14*_)),Math.abs(b-d.uPointerAmount.value)<2e-4&&(d.uPointerAmount.value=b)}}}var qa=`
uniform vec3 uPointer,uPointerNormal;
uniform float uPointerAmount,uPointerRadius;
vec3 indentParticle(vec3 p){
 vec3 delta=p-uPointer;
 float depth=dot(delta,uPointerNormal);
 vec3 tangent=delta-uPointerNormal*depth;
 float distance=length(tangent)/uPointerRadius;
 float bowl=exp(-distance*distance*3.5)*uPointerAmount*exp(-abs(depth)*.24);
 float shoulder=exp(-pow((distance-.95)*5.0,2.0))*uPointerAmount*.09;
 return p-uPointerNormal*(bowl*.9-shoulder)-tangent*bowl*.075;
}`,Ed=`
float particleHash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
float particleNoise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
 return mix(mix(mix(particleHash(i),particleHash(i+vec3(1,0,0)),f.x),mix(particleHash(i+vec3(0,1,0)),particleHash(i+vec3(1,1,0)),f.x),f.y),
 mix(mix(particleHash(i+vec3(0,0,1)),particleHash(i+vec3(1,0,1)),f.x),mix(particleHash(i+vec3(0,1,1)),particleHash(i+vec3(1,1,1)),f.x),f.y),f.z)*2.0-1.0;}
`;var Ya=Math.PI*2,jT=Object.freeze({bass:0,mid:0,treble:0}),QT=new Float32Array(16);function Cd(i,e,t=!1){let n=e||i.reduced,r=e?0:i.sceneTime??i.time??0;return{...i,sceneTime:r,reduced:!!n,dt:i.dynamicDt??(i.playing===!1||n?0:i.dt),...t?{}:{time:r},...n?{level:0,bands:jT,spectrum:QT,onset:0}:{}}}var en=(i,e=0)=>{let t=Math.sin(i*127.1+e*311.7)*43758.5453;return t-Math.floor(t)},_t=(i,e,t,n,r=.05)=>({type:"number",label:i,default:e,min:t,max:n,step:r}),e3={auto:"\u81EA\u52A8",verse:"\u4E3B\u6B4C",chorus:"\u526F\u6B4C",bridge:"\u8FC7\u6E21",venue:"\u7B2C\u4E00\u73B0\u573A",diorama:"\u7EB8\u96D5\u5267\u573A",tempo:"\u8282\u62CD\u5F8B\u52A8",still:"\u9759\u5E27",duo:"\u53CC\u8272",mono:"\u5355\u8272",vivid:"\u6D53\u5F69","split-duo":"\u53CC\u8272\u5206\u5272","quad-grid":"\u56DB\u683C\u6784\u56FE","diagonal-cut":"\u659C\u5207\u6784\u56FE",triptych:"\u4E09\u8054\u6784\u56FE",banded:"\u6A2A\u5411\u8272\u5E26","poster-frame":"\u6D77\u62A5\u8FB9\u6846","fan-burst":"\u653E\u5C04\u6784\u56FE",shutters:"\u767E\u53F6\u6784\u56FE","offset-collage":"\u9519\u4F4D\u62FC\u8D34","editorial-column":"\u793E\u8BBA\u680F","type-impact":"\u6587\u5B57\u51B2\u51FB","fragment-collage":"\u788E\u7247\u62FC\u8D34","tracking-ribbon":"\u8FFD\u8E2A\u5149\u5E26","mask-reveal":"\u906E\u7F69\u63ED\u793A","poster-blocks":"\u6D77\u62A5\u8272\u5757","quiet-tableau":"\u9759\u50CF",orbital:"\u73AF\u7ED5",constellation:"\u661F\u7FA4",perspective:"\u900F\u89C6\u8D70\u5ECA","wave-score":"\u58F0\u6CE2\u8C31\u9762",orrery:"\u661F\u8F68\u4EEA","editorial-lattice":"\u683C\u6805\u8C31\u9762"},cs=(i,e,t)=>({type:"select",label:i,default:e,options:t.map(n=>typeof n=="string"?{value:n,label:e3[n]||n}:n)}),Za={speed:_t("\u8FD0\u52A8\u901F\u5EA6",.6,0,2),reactivity:_t("\u5F8B\u52A8\u5F3A\u5EA6",.7,0,2),scale:_t("\u7A7A\u95F4\u5C3A\u5EA6",1,.5,2),density:_t("\u7C92\u5B50\u5BC6\u5EA6",1,.2,1),director:{type:"boolean",label:"\u81EA\u52A8\u5BFC\u6F14",default:!1},cue:cs("\u6BB5\u843D\u7F16\u6392","auto",["auto","verse","chorus","bridge"]),dust:_t("\u7A7A\u95F4\u5149\u5C18",0,0,1),discRing:{type:"boolean",label:"\u73AF\u7ED5\u9891\u8C31",default:!1},ripples:_t("\u8282\u62CD\u6D9F\u6F2A",0,0,1)};function Ke(i,e){return i.scope.track(e),e}function xn(i){let e=new i.THREE.Group;return i.scene.add(e),i.scope.defer(()=>e.removeFromParent()),e}function Ut(i,e){let t=i.bands?.[e]??(e==="bass"?i.level:0);return Math.min(1,Math.max(0,Number(t)||0))}function ti(i){return Math.max(.1,Math.min(1,i?.density??{low:.4,medium:.7,high:1}[i?.mode]??.7))}function cy(i,e){let t=e.spectrum||e.bands?.spectrum;for(let n=0;n<i.length;n++){let r=t?.[Math.floor(n/i.length*t.length)];i[n]=r===void 0?Ut(e,n<5?"bass":n<11?"mid":"treble"):Math.max(0,Math.min(1,r>1?r/255:Number(r)||0))}}function yn(i,e,t,n={}){let r=!1;return{group:i,update(s){r||n.update?.(s,e)},resize(s,o){n.resize?.(s,o)},setParams(s){e={...e,...s},n.params?.(e)},setQuality(s){t=s,n.quality?.(t)},dispose(){r||(r=!0,n.dispose?.(),i.removeFromParent())},stats:()=>n.stats?.()||{}}}var t3=`
attribute float aSeed; attribute vec2 aCover;
uniform float uTime,uBass,uMid,uTreble,uMotion,uResponse,uSize,uMode,uPixel,uHeight,uRefined;
uniform float uBands[16];
varying vec3 vColor; varying vec2 vCover;varying float vAlpha,vGlow;
${Ed}
${qa}
float noise(vec3 p){return particleNoise(p);}
mat2 turn(float a){return mat2(cos(a),-sin(a),sin(a),cos(a));}
void main(){
 vec3 p=position;float t=uTime*uMotion,a=aCover.x*6.2831853,b=aCover.y;
 float band=uBands[int(clamp(floor(aCover.x*16.0),0.0,15.0))],drive=band*uResponse;
 vColor=color;vCover=aCover;vAlpha=.72;vGlow=.2;
 if(uMode<.5||uMode>8.5){
  float y=1.0-2.0*b;vec3 n=vec3(cos(a)*sqrt(max(0.0,1.0-y*y)),y,sin(a)*sqrt(max(0.0,1.0-y*y)));
  float detail=noise(n*3.2+vec3(0,t*.3,t*.18));
  float r=3.2+uBass*uResponse*.22+detail*(.08+uTreble*uResponse*.28);
  if(uMode>8.5)r+=drive*(.3+pow(.5+.5*sin(a*32.0),6.0)*1.4);
  p=n*r;p.xz=turn(t*.15)*p.xz;
  float contour=pow(.5+.5*sin(n.y*42.0+detail*2.0+t*.24),7.0);
  vAlpha=.22+.62*contour;vGlow=contour*.3+drive*.25;
 }else if(uMode<1.5){
  float arm=floor(aCover.x*4.0),r=pow(b,.68)*10.0;
  float spread=(fract(aCover.x*4.0)-.5)*(.12+b*.5);
  float angle=arm*1.5707963+r*.62+t*.045+spread;
  float lane=exp(-pow(spread/(.07+b*.19),2.0));
  p=vec3(cos(angle)*r,(aSeed-.5)*(.24+(1.0-b)*.65)+sin(r*.7-t*.25)*.09,sin(angle)*r);
  p.y+=drive*sin(r*1.2-t)*.14;
  vAlpha=(.16+lane*.62)*(1.0-smoothstep(.78,1.0,b));vGlow=pow(1.0-b,5.0)*.45+drive*.18;
 }else if(uMode<2.5){
  float layer=floor(b*6.0),local=fract(b*6.0),flow=aCover.x*24.0-12.0;
  float phase=flow*.26+layer*.8+t*.08;
  p=vec3(flow,sin(phase)*2.0+(layer-2.5)*.72+(local-.5)*1.2,-3.0-layer*2.1+cos(phase)*2.0);
  p.y+=noise(vec3(flow*.25,layer,t*.12))*.65+drive*.25;
  float ridge=exp(-pow((local-.48)/.2,2.0));vAlpha=.08+ridge*.72;vGlow=ridge*.5;
 }else if(uMode<3.5){
  float flow=fract(b+t*.045),z=5.0-flow*52.0,spin=a+t*.1+sin(flow*6.0+t*.12)*.045;
  float radius=4.1-uBass*uResponse*.22+sin(a*5.0+z*.35-t*.5)*(.07+uMid*uResponse*.14);
  p=vec3(cos(spin)*radius,sin(spin)*radius,z);
  float ring=pow(.5+.5*cos(flow*150.796),18.0);
  float seam=pow(.5+.5*cos(a*24.0),24.0);
  vCover=vec2(aCover.x,flow);vAlpha=(.1+ring*.65+seam*.18)*(1.0-smoothstep(12.0,52.0,-z));vGlow=ring*.24+drive*.25;
 }else if(uMode<4.5){
  p=vec3((aCover.x-.5)*30.0,-3.0,-b*32.0+6.0);
  float wave=sin(p.x*.32+t*.5)*cos(p.z*.23-t*.25);
  p.y+=wave*(1.2+uBass*uResponse*1.5)+drive*1.6;
  vAlpha=.35+.5*pow(.5+.5*sin(b*160.0),8.0);vGlow=max(0.0,p.y+2.0)*.15;
 }else if(uMode<5.5&&uRefined>.5){
  float ribbon=floor(b*3.0),v=fract(b*3.0)-.5,x=(aCover.x-.5)*14.0;
  float curl=x*.38+t*.18+ribbon*1.7;
  p=vec3(x,sin(curl)*(1.0+ribbon*.3)+v*(.8+.25*cos(curl)),cos(curl*.78+ribbon)*1.4+(ribbon-1.0)*1.2);
  float fold=noise(vec3(x*.65,v*2.0,t*.2+ribbon));
  p.z+=fold*(.12+uBass*uResponse*.25)+sin(v*18.0+x*.8-t)*uMid*uResponse*.12;
  float filament=pow(.5+.5*cos(v*65.0+fold*.8),7.0);
  float edge=pow(abs(v)*2.0,4.0);
  vAlpha=(.12+filament*.44+edge*.25)*(1.0-smoothstep(.82,1.0,abs(x)/7.0));vGlow=filament*.25+drive*.18;
 }else if(uMode<5.5||uMode>7.5){
  p=vec3((aCover.x-.5)*12.0,(b-.5)*8.0,0);
  float broad=noise(vec3(p.xy*.45,t*.28)),fine=noise(vec3(p.xy*1.2,t*.42));
  p.z=broad*(.7+uBass*uResponse*.7)+fine*uMid*uResponse*.65;
  p.z+=sin(length(p.xy)*3.0-t*2.2)*uBass*uResponse*.22;
  if(uMode<7.5){p.y+=sin(p.x*.5+t*.25)*.7;p.z+=sin(p.x*.4+t*.3)*1.3;}
  vAlpha=.8;vGlow=abs(broad)*drive*.4;
 }else if(uMode<6.5){
  float r=pow(b,.72),theta=a+r*.7+t*.025,petal=.5+.5*cos(theta*9.0-r*3.8);
  float radius=r*(5.0+uBass*uResponse*.5)*(.8+petal*.3);
  p=vec3(cos(theta)*radius,sin(theta)*radius*.82,(1.0-r)*1.7-r*r*.7+sin(theta*9.0-r*5.0+t*.14)*(.2+r*.7));
  p.yz=turn(-.3)*p.yz;vAlpha=.2+petal*.5;vGlow=pow(r,4.0)*.6+drive*.3;
 }else{
  float column=floor(aCover.x*52.0),fall=fract(b+t*(.04+aSeed*.05));
  p=vec3((column/51.0-.5)*18.0,(.5-fall)*13.0,(aSeed-.5)*10.0-2.0);
  p.x+=sin(t*.17+column*.63+fall*3.4)*.15;
  float dash=pow(.5+.5*sin(fall*(70.0+aSeed*40.0)),10.0);vAlpha=.12+dash*.8;vGlow=dash*.4;
 }
 if(uRefined>.5){
  p=indentParticle(p);
  float twinkle=.82+.18*sin(t*.52+aSeed*40.0);
  vAlpha*=twinkle;vGlow*=.7;
 }
 vec4 mv=modelViewMatrix*vec4(p,1.0); gl_Position=projectionMatrix*mv;
 float focus=1.0-smoothstep(14.0,52.0,-mv.z);
 float size=uSize*uPixel*(.86+aSeed*.36+vGlow*.3+uTreble*uResponse*.08)*uHeight*.045/max(2.0,-mv.z);
 gl_PointSize=clamp(size*mix(1.0,1.38,uRefined),1.0,5.4);vAlpha*=mix(.42,1.0,focus);
}`,n3=`
uniform sampler2D uCover;uniform float uHasCover,uArtwork,uRefined;varying vec3 vColor;varying vec2 vCover;varying float vAlpha,vGlow;
void main(){float r=length(gl_PointCoord-.5);if(r>.5)discard;
 vec3 sampled=texture2D(uCover,clamp(vCover,.002,.998)).rgb;
 vec3 c=mix(vColor,sampled,uHasCover*mix(.36,1.0,uArtwork));
 c*=1.08+vGlow*.25;
 c=mix(c,sqrt(max(c,vec3(0.0))),uRefined*.4);
 float core=1.0-smoothstep(.16,.42,r),halo=exp(-r*r*20.0)*.09;
 float alpha=clamp(mix(1.0-smoothstep(.18,.5,r),(core+halo)*1.85,uRefined)*vAlpha,0.0,.98);
 gl_FragColor=vec4(c,alpha);
 #include <colorspace_fragment>
}`;function Br(i,e,t=[6805967,16478872,9419263]){let n=i.THREE,r=xn(i),s=24e3,o=["silk","sphere","tunnel","galaxy"].includes(e),a=Xa(i,r,{depth:e==="sphere"?2.8:e==="tunnel"?-5:0,radius:e==="galaxy"?2:1.4}),l=new Float32Array(s*3),c=new Float32Array(s*3),u=new Float32Array(s),f=new Float32Array(s*2),h=new n.Color,d=new n.Color(t[0]),p=new n.Color(t[1]),v={sphere:0,galaxy:1,aurora:2,tunnel:3,terrain:4,silk:5,nebula:6,flow:7,cover:8,"spectrum-sphere":9};for(let I=0;I<s;I++){let D=en(I,1)*Ya,B=en(I,2),F=en(I,3),L=I*3;if(f[I*2]=D/Ya,f[I*2+1]=B,e==="sphere"||e==="cover"){let X=1-B*2,te=Math.sqrt(1-X*X)*3.2;l[L]=Math.cos(D)*te,l[L+1]=X*3.2,l[L+2]=Math.sin(D)*te}else if(e==="galaxy"){let X=Math.pow(B,.65)*10,te=D*.08+X*.65+I%4*Ya/4;l[L]=Math.cos(te)*X,l[L+1]=(F-.5)*(1.6-B),l[L+2]=Math.sin(te)*X}else if(e==="tunnel"){let X=I%48,te=4+F*.14;l[L]=Math.cos(D)*te,l[L+1]=Math.sin(D)*te,l[L+2]=-X-.5}else if(e==="terrain")l[L]=(D/Ya-.5)*28,l[L+1]=Math.sin(D*2)*.3-3,l[L+2]=-B*26+6;else if(e==="aurora")l[L]=(D/Ya-.5)*24,l[L+1]=B*7-2,l[L+2]=-4-I%5*2+Math.sin(D*2)*1.5;else if(e==="silk")l[L]=(D/Ya-.5)*15,l[L+1]=Math.sin(D*3)*1.8+(B-.5)*2,l[L+2]=(F-.5)*8;else{let X=Math.cbrt(B)*9;l[L]=Math.cos(D)*X,l[L+1]=(F-.5)*7,l[L+2]=Math.sin(D)*X}let U=e==="aurora"||e==="nebula"?B:e==="galaxy"?I%4/3:e==="sphere"?B:en(I,5);h.copy(d).lerp(p,U),h.toArray(c,L),u[I]=F}let g=Ke(i,new n.BufferGeometry);g.setAttribute("position",new n.BufferAttribute(l,3)),g.setAttribute("color",new n.BufferAttribute(c,3)),g.setAttribute("aSeed",new n.BufferAttribute(u,1)),g.setAttribute("aCover",new n.BufferAttribute(f,2));let m={...a.uniforms,uTime:{value:0},uBass:{value:0},uMid:{value:0},uTreble:{value:0},uHeight:{value:720},uRefined:{value:Number(o)},uMotion:{value:.6},uResponse:{value:.7},uSize:{value:e==="cover"?1.7:1},uPixel:{value:1},uArtwork:{value:e==="cover"?1:0},uMode:{value:v[e]??6},uCover:{value:null},uHasCover:{value:0},uBands:{value:new Float32Array(16)}},y=Ke(i,new n.ShaderMaterial({uniforms:m,vertexShader:t3,fragmentShader:n3,vertexColors:!0,transparent:!0,depthWrite:!1,blending:e==="cover"||o?n.NormalBlending:n.AdditiveBlending})),_=new n.Points(g,y);_.frustumCulled=!1,r.add(_);let x=i.quality,S={...i.params},b=null,E="",M=i.services.spatialResources||Ei(n),T=!i.services.spatialResources;i.scope.defer(()=>{M.cover.release(b),T&&M.dispose()});function A(){g.setDrawRange(0,Math.floor(s*ti(x)*(S.density??1)))}return A(),yn(r,S,x,{update(I,D){let B=Number(I.time)||0;if(m.uTime.value=B,m.uBass.value=Ut(I,"bass"),m.uMid.value=Ut(I,"mid"),m.uTreble.value=Ut(I,"treble"),cy(m.uBands.value,I),m.uMotion.value=D.speed??.6,m.uResponse.value=D.reactivity??.7,m.uPixel.value=i.renderer?.getPixelRatio()||1,m.uSize.value=D.pointSize??(e==="cover"?1.7:1),r.scale.setScalar((D.scale??1)*(D.cue==="chorus"?1.08:1)),r.rotation.set(D.cue==="bridge"?.06:0,0,D.director?Math.sin(B*.08)*.04:0),D.cue==="chorus"&&(m.uResponse.value*=1.3),o&&a.update(I,(D.pointerStrength??1)*.65),M){let F=i.services.coverUrl,L=(typeof F=="function"?F():F)||I.coverUrl||"";L!==E&&(M.cover.release(b),E=L,b=M.cover.acquire(L,i.signal)),m.uCover.value=b?.texture||null,m.uHasCover.value=b?.texture?1:0}},resize(I,D){m.uHeight.value=D},params(I){S=I,A()},quality(I){x=I,A()},stats(){return{particles:g.drawRange.count,drawCalls:1,bytes:l.byteLength+c.byteLength+u.byteLength+f.byteLength}}})}function uy(i,e="spectrum"){let t=i.THREE,n=xn(i),r=256,s=Ke(i,new t.BoxGeometry(.32,1,.32)),o=Ke(i,new t.ShaderMaterial({vertexColors:!0,wireframe:e==="wire",vertexShader:`varying vec3 vColor;varying float vY;varying vec3 vNormal;
    void main(){vY=position.y+.5;vNormal=normal;vColor=color;
    #ifdef USE_INSTANCING_COLOR
    vColor*=instanceColor;
    #endif
    gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);}`,fragmentShader:`varying vec3 vColor,vNormal;varying float vY;
    void main(){vec3 c=vColor*mix(.18,1.1,pow(vY,1.4))*(.6+abs(vNormal.z)*.4);
    c+=vec3(.6,.9,1.0)*smoothstep(.97,1.0,vY)*.5;gl_FragColor=vec4(c,1.0);
    #include <colorspace_fragment>
    }`})),a=Ke(i,new t.InstancedMesh(s,o,r)),l=new t.Object3D,c=new t.Color;n.add(a);function u(h,d){for(let p=0;p<a.count;p++){let v=p%16-7.5,g=Math.floor(p/16)-7.5,m=h.spectrum||h.bands?.spectrum,y=m?.[Math.floor(p/r*m.length)],_=y===void 0?Ut(h,p%3===0?"bass":"mid"):Math.min(1,y>1?y/255:y),x=Math.sin(Math.hypot(v,g)*.8-(h.time||0)*(d.speed??.6)),S=.12+_*(2.3+x*1.3)*(d.reactivity??.7)+(x+1)*.12;l.position.set(v*.65,S/2-2,g*.65),l.scale.set(1,S,1),l.updateMatrix(),a.setMatrixAt(p,l.matrix),c.setHSL(.48+(v+7.5)/15*.4,.75,.42+_*.18),a.setColorAt(p,c)}a.instanceMatrix.needsUpdate=!0,a.instanceColor&&(a.instanceColor.needsUpdate=!0),n.scale.setScalar(d.scale??1)}function f(h){a.count=Math.floor(r*ti(h))}return f(i.quality),u({time:0},i.params),yn(n,i.params,i.quality,{update:u,quality:f,stats:()=>({instances:a.count,triangles:a.count*12,drawCalls:1})})}function hy(i,e=!1){let t=i.THREE,n=xn(i),r=e?36:12,s=Ke(i,new t.TorusGeometry(e?4:3,e?.018:.014,4,128)),o=Ke(i,new t.MeshBasicMaterial({color:16777215,transparent:!0,opacity:.8,blending:t.AdditiveBlending,depthWrite:!1})),a=Ke(i,new t.InstancedMesh(s,o,r)),l=new t.Object3D,c=new t.Color,u=new t.Color(e?15953580:15714694);if(n.add(a),!e){let d=new t.Mesh(Ke(i,new t.SphereGeometry(1.05,32,24)),Ke(i,new t.MeshBasicMaterial({color:197894})));n.add(d)}function f(d,p){let v=d.time||0,g=Ut(d,"bass");for(let m=0;m<a.count;m++){let y=m/a.count,_=v*(p.speed??.6),x=g*(p.reactivity??.7);l.position.set(e?Math.sin(m*.2+_*.1)*.25:0,0,e?-(((m*2-_*3)%72+72)%72):(y-.5)*1.5),l.rotation.set(e?0:-.4+y*.8,e?0:Math.sin(y*6+_*.06)*.18,e?m*.09+_*.12:-.22+y*.5);let S=e?1:.5+y*1.1;l.scale.set(S*(1+x*.08),S*(e?1:.5+y*.16),1),l.updateMatrix(),a.setMatrixAt(m,l.matrix),c.set(e?7397358:9096432).lerp(u,y),a.setColorAt(m,c)}a.instanceMatrix.needsUpdate=!0,a.instanceColor&&(a.instanceColor.needsUpdate=!0),n.scale.setScalar(p.scale??1)}function h(d){a.count=Math.max(6,Math.floor(r*ti(d)))}return h(i.quality),f({time:0},i.params),yn(n,i.params,i.quality,{update:f,quality:h,stats:()=>({instances:a.count,triangles:a.count*1024+(e?0:1472),drawCalls:e?1:2})})}function Rd(i,e="terrain"){let t=i.THREE,n=xn(i),r=Ke(i,new t.PlaneGeometry(24,24,64,64));r.rotateX(-Math.PI/2);let s={uTime:{value:0},uBass:{value:0},uSpeed:{value:.6},uResponse:{value:.7},uStyle:{value:e==="mesh"?1:e==="spectrogram"?2:0},uBands:{value:new Float32Array(16)}},o=Ke(i,new t.ShaderMaterial({uniforms:s,side:t.DoubleSide,vertexShader:`uniform float uTime,uBass,uSpeed,uResponse,uStyle;uniform float uBands[16];varying float vHeight;varying vec2 vGrid;
    void main(){vec3 p=position;float t=uTime*uSpeed;
    p.y=sin(p.x*.32+t*.3)*cos(p.z*.23+t*.16)*(1.2+uBass*uResponse*2.0);
    float band=uBands[int(clamp(floor((p.x+12.0)/24.0*16.0),0.0,15.0))];p.y+=band*uResponse*2.0;
    if(uStyle>1.5)p.y=band*(1.2+sin(p.z*.8-t)*.8)*uResponse*3.0+sin(p.x*.3+t)*.3;
    vHeight=p.y;vGrid=p.xz;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}`,fragmentShader:`uniform float uStyle;varying float vHeight;varying vec2 vGrid;
    void main(){vec2 coord=vGrid*(uStyle>1.5?1.8:2.5),width=fwidth(coord);
    vec2 line=abs(fract(coord-.5)-.5)/max(width,vec2(.001));float grid=1.0-min(min(line.x,line.y),1.0);
    vec3 c=mix(vec3(.08,.45,.51),vec3(.96,.42,.55),smoothstep(-1.5,3.5,vHeight));
    c*=mix(.13,.28,step(.5,uStyle))+grid*.9;c+=vec3(.14,.22,.2)*pow(max(0.0,vHeight)*.15,2.0);
    gl_FragColor=vec4(c,1.0);
    #include <colorspace_fragment>
    }`})),a=new t.Mesh(r,o);a.position.y=-3,n.add(a);let l=r.index.count;function c(){r.setDrawRange(0,l)}return c(i.quality),yn(n,i.params,i.quality,{update(u,f){s.uTime.value=u.time||0,s.uBass.value=Ut(u,"bass"),s.uSpeed.value=f.speed??.6,s.uResponse.value=f.reactivity??.7,cy(s.uBands.value,u),n.scale.setScalar(f.scale??1)},quality:c,stats:()=>({triangles:r.drawRange.count/3,drawCalls:1})})}function Nu(i,e){let t=i.THREE,n=xn(i),r=32,s=Ke(i,new t.BufferGeometry);s.setAttribute("position",new t.Float32BufferAttribute([0,-.5,0,-1,.7,.6,-.35,-.3,.15,0,-.5,0,.35,-.3,.15,1,.7,.6],3)),s.setAttribute("uv",new t.Float32BufferAttribute([.5,0,0,1,.3,.2,.5,0,.7,.2,1,1],2)),s.computeVertexNormals();let o=i.services.spatialResources||Ei(t),a=!i.services.spatialResources,l=null,c="",u=!1;function f(){u||(u=!0,o.cover.release(l),a&&o.dispose())}i.scope.defer(f);let h={uTime:{value:0},uStyle:{value:["manga","anime","pencil","color"].indexOf(e)},uBass:{value:0},uCover:{value:null},uHasCover:{value:0}},d=Ke(i,new t.ShaderMaterial({uniforms:h,side:t.DoubleSide,vertexShader:`uniform float uTime,uBass;varying vec3 vNormal;varying vec2 vUv;void main(){vec3 p=position;vUv=uv;
    #ifdef USE_INSTANCING
    vNormal=normalize(normalMatrix*mat3(instanceMatrix)*normal);p.z+=abs(p.x)*sin(uTime*.7)*(.15+uBass*.2);
    gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(p,1.0);
    #else
    vNormal=normalize(normalMatrix*normal);p.z+=sin(p.x*.6+uTime*.2)*cos(p.y*.5)*(.15+uBass*.2);
    gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
    #endif
    }`,fragmentShader:`uniform float uTime,uStyle,uBass,uHasCover;uniform sampler2D uCover;varying vec3 vNormal;varying vec2 vUv;void main(){
    float shade=floor((dot(normalize(vNormal),normalize(vec3(.4,.8,1.0)))*.5+.5)*4.0)/4.0;
    float dots=step(.22,length(fract(gl_FragCoord.xy/5.0)-.5));float hatch=step(.7,fract((gl_FragCoord.x+gl_FragCoord.y)/7.0));
    vec3 art=mix(mix(vec3(.18,.65,.6),vec3(.98,.5,.65),vUv.x),texture2D(uCover,vUv).rgb,uHasCover);
    float lum=dot(art,vec3(.299,.587,.114));
    vec2 texel=vec2(.002,0);float edge=length(texture2D(uCover,vUv+texel).rgb-texture2D(uCover,vUv-texel).rgb);
    vec3 c;
    if(uStyle<.5)c=vec3(floor(lum*5.0)/5.0*.8+.12)*mix(.56,1.0,dots);
    else if(uStyle<1.5)c=floor(art*5.0)/5.0*(.75+shade*.25);
    else if(uStyle<2.5)c=vec3(.9,.93,.91)*(1.0-edge*2.0)*mix(.55,1.0,lum)*mix(.72,1.0,hatch);
    else c=mix(vec3(.08,.55,.53),vec3(.98,.42,.57),smoothstep(.2,.8,lum))*mix(.78,1.0,dots);
    c*=1.0-clamp(edge*1.5,0.0,.65);gl_FragColor=vec4(c,1.0);
    #include <colorspace_fragment>
    }`})),p=Ke(i,new t.InstancedMesh(s,d,r)),v=new t.Object3D;n.add(p);let g=new t.Mesh(Ke(i,new t.PlaneGeometry(6.4,6.4,48,48)),d);n.add(g);function m(_,x){let S=_.time||0,b=i.services.coverUrl,E=(typeof b=="function"?b():b)||_.coverUrl||"";c!==E&&(o.cover.release(l),c=E,l=o.cover.acquire(E,i.signal)),h.uCover.value=l?.texture||null,h.uHasCover.value=l?.texture?1:0,h.uTime.value=S*(x.speed??.6),h.uBass.value=Ut(_,"bass")*(x.reactivity??.7),g.rotation.set(Math.sin(S*.07)*.035,Math.sin(S*.05)*.08,0);for(let M=0;M<p.count;M++){let T=M*2.4+S*.025*(x.speed??.6),A=5+M%3;v.position.set(Math.cos(T)*A,Math.sin(M*.8)*4.5,-2-en(M,3)*5),v.rotation.set(Math.sin(S*.3+M)*.3,M*.4,Math.sin(M)*.35),v.scale.setScalar(.3+en(M,3)*.6),v.updateMatrix(),p.setMatrixAt(M,v.matrix)}p.instanceMatrix.needsUpdate=!0,n.scale.setScalar(x.scale??1)}function y(_){p.count=Math.max(12,Math.floor(r*ti(_)))}return y(i.quality),m({},i.params),yn(n,i.params,i.quality,{update:m,quality:y,dispose:f,stats:()=>({instances:p.count,triangles:p.count*2+4608,drawCalls:2})})}var py="varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",i3=`
uniform sampler2D uText;uniform vec4 uRows[6];uniform float uFill[6];
uniform float uCurrent,uOpacity,uTime,uGlow,uReveal,uKaraoke,uStyle;uniform vec2 uTexel;
uniform vec3 uBase,uHighlight;varying vec2 vUv;
void main(){
 vec2 uv=gl_FrontFacing?vUv:vec2(1.0-vUv.x,vUv.y);
 float mask=texture2D(uText,uv).a;
 float halo=max(max(texture2D(uText,uv+uTexel*vec2(2,0)).a,texture2D(uText,uv-uTexel*vec2(2,0)).a),
 max(texture2D(uText,uv+uTexel*vec2(0,2)).a,texture2D(uText,uv-uTexel*vec2(0,2)).a));
 if(max(mask,halo)<.01||uv.x>uReveal)discard;
 float filled=0.0,edge=0.0;
 for(int i=0;i<6;i++){vec4 row=uRows[i];if(uv.y>=row.z&&uv.y<=row.w){
  filled=1.0-smoothstep(uFill[i]-.004,uFill[i]+.004,uv.x);
  edge=exp(-pow((uv.x-uFill[i])/.018,2.0));}}
 float currentMix=clamp(uCurrent,0.0,1.0);
 vec3 color=mix(uBase,uHighlight,filled*currentMix*uKaraoke);
 color+=uHighlight*edge*currentMix*uKaraoke*(.12+uGlow*.12);
 float sweep=pow(max(0.0,sin(uv.x*5.0-uv.y*.6-uTime*.8)),18.0);
 color+=uHighlight*sweep*currentMix*uGlow*.045;
 float alpha=mask;
 if(uStyle>.5&&uStyle<1.5)alpha*=1.0-filled*currentMix*.55*uKaraoke;
 float shadow=max(0.0,halo-mask)*.6;
 gl_FragColor=vec4(mix(vec3(.005),color,alpha/max(.001,alpha+shadow)),max(alpha,shadow)*uOpacity);
 #include <colorspace_fragment>
}`,fy=["editorial-column","type-impact","fragment-collage","tracking-ribbon","mask-reveal","poster-blocks","quiet-tableau"],dy=["split-duo","quad-grid","diagonal-cut","triptych","banded","poster-frame","fan-burst","shutters","offset-collage"];function lo(i,e="corridor"){let t=i.THREE,n=xn(i),r=i.services.spatialResources||Ei(t),s=!i.services.spatialResources,o=Ke(i,new t.PlaneGeometry(1,1,e==="cadenza"?80:1,1)),a=e==="tempera"?16764561:e==="sonnet"?16768684:e==="cadenza"?9366493:9560063,l=Array.from({length:7},()=>{let y={uText:{value:null},uRows:{value:Array.from({length:6},()=>new t.Vector4(0,0,-1,-1))},uFill:{value:new Float32Array(6)},uCurrent:{value:0},uOpacity:{value:0},uTime:{value:0},uGlow:{value:0},uReveal:{value:1},uKaraoke:{value:1},uStyle:{value:e==="wipe"?1:0},uTexel:{value:new t.Vector2(.0009765625,.00390625)},uBase:{value:new t.Color(15856629)},uHighlight:{value:new t.Color(a)}},_=e==="cadenza"?`uniform float uTime,uCurrent,uGlow;varying vec2 vUv;void main(){vUv=uv;vec3 p=position;
      p.y+=sin(uv.x*24.0+uTime*.3)*uCurrent*uGlow*.018;p.z+=sin(uv.x*13.0-uTime*.2)*uCurrent*.08;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}`:py,x=Ke(i,new t.ShaderMaterial({uniforms:y,vertexShader:_,fragmentShader:i3,transparent:!0,depthWrite:!1,depthTest:!1,side:t.DoubleSide})),S=new t.Mesh(o,x);return S.visible=!1,S.renderOrder=2,n.add(S),{mesh:S,key:"",entry:null,line:null,rel:0,fresh:!0,targetPosition:new t.Vector3,targetScale:new t.Vector3,targetRotation:new t.Euler,targetQuaternion:new t.Quaternion}}),c=Ke(i,new t.InstancedMesh(Ke(i,new t.BoxGeometry(1,1,1)),Ke(i,new t.MeshBasicMaterial({color:a,wireframe:e!=="tempera",transparent:!0,opacity:e==="tempera"?.22:.17})),24));n.add(c);let u=new t.Object3D,f=new t.Color,h=!1,d=i.camera.aspect||16/9,p=null;function v(){h||(h=!0,l.forEach(y=>r.text.release(y.entry)),s&&r.dispose())}i.scope.defer(v);function g(y,_){let x=y.lyrics||i.services.lyrics||{},S=x.lines||[],b=x.localIndex??x.index??0,E=x.trackIndex??b,M=d<.8?896:d<1.2?1344:1792,T=y.time||0,A=y.sceneTime??T,I=Math.max(0,y.dynamicDt??y.dt??0),D=p===null||y.playing===!1||y.reduced||Math.abs(E-p)>1,B=1-Math.exp(-I*9);p=E;let F=[];for(let ne=-3;ne<=3;ne++){let ie=S[b+ne];ie?.text&&F.push({line:ie,rel:ne,key:String(ie.start??E+ne)+":"+ie.text})}l.forEach(ne=>{F.some(ie=>ie.key===ne.key)&&ne.wrapWidth===M||(r.text.release(ne.entry),ne.entry=null,ne.key="",ne.mesh.visible=!1)}),F.sort((ne,ie)=>Math.abs(ne.rel)-Math.abs(ie.rel)).forEach(ne=>{let ie=l.find(We=>We.key===ne.key)||l.find(We=>!We.key);ie&&(ie.key!==ne.key&&(ie.fresh=!0),ie.key=ne.key,ie.mesh.userData.lyricKey=ne.key,ie.rel=ne.rel,ie.line=ne.line,ie.wrapWidth=M,ie.entry||(ie.entry=r.text.acquire(ne.line.text,e==="sonnet"?"serif":"sans-serif",M)))}),r.beginFrame(y.now??A);let L=Math.max(8,i.camera.position.length()),U=2*L*Math.tan(i.camera.fov*Math.PI/360),X=U*d,te=Math.min(_.textWidth??12,X*.82),Z=_.spacing??2.1;l.forEach(ne=>{let ie=ne.entry?.layout;if(!ie)return;let We=Math.min(ne.rel===0?.96:.64,te*ie.fontSize/ie.width,U*(ne.rel===0?.42:.3)*ie.fontSize/ie.height);ne.width=ie.width/ie.fontSize*We,ne.height=ie.height/ie.fontSize*We,Z=Math.max(Z,ne.height+.35)}),l.forEach(ne=>{let{mesh:ie,entry:We,rel:Fe,line:Ye}=ne,$=We?.layout;if(ie.visible=!!We?.texture&&Math.abs(Fe)<=2,!ie.visible)return;let oe=Math.abs(Fe),Ce=Fe===0,He=ie.material.uniforms,Ee=Math.sin(Fe*.35)*(_.arc??.7)*.28,ze=-oe*.55,pt=-Fe*Z,ae=ne.targetRotation;if(ae.set(0,0,0),e==="cadenza"&&(Ee+=Fe*.32,ze-=oe*.5,ae.z=Fe*-.018),e==="sonnet"&&(Ee-=Math.min(.6,X*.03),ze-=oe*.3),e==="tempera"&&(Ee+=Math.sin(Fe*2.4)*.3,ae.z=Math.sin(Fe)*.018),ne.targetScale.set(ne.width,ne.height,1),He.uReveal.value=1,e==="sonnet"){let Te=!_.shotFlow||_.shotFlow==="auto"?fy[Math.floor(A/9)%fy.length]:_.shotFlow;Te==="fragment-collage"&&(Ee+=Math.sin(Fe*3)*.3,ae.z=Fe*.016),Te==="tracking-ribbon"&&(Ee+=Math.sin(A*.3)*.18,ze-=oe*.3),Te==="type-impact"&&Ce&&ne.targetScale.multiplyScalar(1+Math.sin(A*.5)*.025),Te==="mask-reveal"&&Ce&&(He.uReveal.value=Math.max(We.end,1-Math.exp(-Math.max(0,T-(Ye.start||0))*8))),Te==="poster-blocks"&&(ze-=oe%2*.4),Te==="quiet-tableau"&&(Ee=0)}_.layout==="diorama"&&(ze-=oe*.6,ae.y=Fe*-.035),_.layout==="tempo"&&(pt+=Math.sin(A*2+Fe)*Ut(y,"bass")*.08),_.layout==="still"&&ae.set(0,0,0);let xe=ne.width*.5,we=X*.45;Ee=Math.max(-Math.max(0,we-xe),Math.min(Math.max(0,we-xe),Ee)),ne.targetPosition.set(Ee,pt,ze),ne.targetQuaternion.setFromEuler(ae),D||ne.fresh?(ie.position.copy(ne.targetPosition),ie.scale.copy(ne.targetScale),ie.quaternion.copy(ne.targetQuaternion)):(ie.position.lerp(ne.targetPosition,B),ie.scale.lerp(ne.targetScale,B),ie.quaternion.slerp(ne.targetQuaternion,B)),ne.fresh=!1,He.uText.value=We.texture,He.uCurrent.value=Ce?1:0,He.uKaraoke.value=_.karaoke===!1?0:1,He.uTexel.value.set(1/$.width,1/$.height),He.uTime.value=A,He.uGlow.value=y.reduced?0:.25+Ut(y,"bass")*.5,He.uOpacity.value=Ce?1:Math.max(.1,.54-oe*.13);let Ae=ly($,Ye,T,x.progress);for(let Te=0;Te<6;Te++){let de=$.rows[Te];He.uRows.value[Te].set(de?.left||0,de?.right||0,de?.bottom??-1,de?.top??-1),He.uFill.value[Te]=Ae[Te]??-1}});let K=Math.max(X*.47,te*.6),j=_.sceneKind||"orbital";for(let ne=0;ne<c.count;ne++){let ie=ne%2?1:-1,We=Math.floor(ne/2),Fe=ne/c.count*Math.PI*2;if(u.position.set(ie*K,(We%5-2)*1.7,-2-We*1.2),u.scale.set(.025,e==="classic"?.6+Ut(y,"mid"):1.1,.025),u.rotation.set(0,A*.02,0),(e==="corridor"||e==="wipe")&&u.scale.set(.018,8,.018),e==="cadenza"&&(u.scale.set(.4,.4,.4),u.rotation.z=A*.05+ne),e==="sonnet"&&(u.scale.set(.3,.025,.2),(j==="orbital"||j==="orrery")&&(u.position.set(Math.cos(Fe+A*.04)*K*1.1,Math.sin(Fe+A*.04)*5,-4-ne%3),u.rotation.z=Fe,u.scale.x=j==="orrery"?1:.3),j==="constellation"&&(u.position.y=(en(ne,2)-.5)*10,u.scale.setScalar(.08)),j==="perspective"&&(u.position.y=ie*4,u.position.z=-We*2,u.scale.z=1.5),j==="wave-score"&&(u.position.y=Math.sin(A*.4+We*.7)*3,u.scale.y=.3+Ut(y,"mid")),j==="editorial-lattice"&&(u.position.y=(We%4-1.5)*2,u.scale.x=1.3)),e==="tempera"){let Ye=!_.composition||_.composition==="auto"?dy[Math.floor(A/16)%dy.length]:_.composition;u.scale.set(1.5,1.2,.15),u.position.z=-4-We%3*2,Ye==="quad-grid"&&(u.position.y=(We%2?1:-1)*3),Ye==="diagonal-cut"&&(u.rotation.z=-.4,u.scale.set(3,.6,.15)),Ye==="triptych"&&u.scale.set(.8,3,.15),(Ye==="banded"||Ye==="shutters")&&u.scale.set(2.6,Ye==="banded"?.6:.3,.15),Ye==="poster-frame"&&(u.position.y=(We%2?1:-1)*4,u.scale.set(.18,2.5,.15)),Ye==="fan-burst"&&(u.rotation.z=ie*We*.22,u.scale.set(3,.25,.15)),Ye==="offset-collage"&&(u.position.y+=en(ne,2),u.rotation.z=ie*.15),f.setHSL(_.colorMode==="mono"?0:ne%2?.47:.055,_.colorMode==="mono"?0:_.colorMode==="vivid"?.9:.5,.4),c.setColorAt(ne,f)}u.updateMatrix(),c.setMatrixAt(ne,u.matrix)}c.instanceMatrix.needsUpdate=!0,c.instanceColor&&(c.instanceColor.needsUpdate=!0),c.visible=!!S.length,n.scale.setScalar(_.scale??1),n.rotation.y=_.director?Math.sin(A*.08)*.025:0}function m(y){c.count=Math.max(8,Math.floor(24*ti(y)))}return m(i.quality),yn(n,i.params,i.quality,{update:g,quality:m,resize(y,_){d=y/Math.max(1,_)},dispose:v,stats:()=>({textRows:l.filter(y=>y.entry).length,drawCalls:6,triangles:c.count*12+10,...r.stats()})})}function my(i){let e=i.THREE,t=xn(i),n=i.services.spatialResources||Ei(e),r=!i.services.spatialResources,s=Ke(i,new e.PlaneGeometry(3,3,24,1)),o=[],a=[],l=[],c=[],u=s.attributes.position;for(let v=0;v<u.count;v++){let g=u.getX(v);u.setXYZ(v,Math.sin(g/11)*11,u.getY(v),(Math.cos(g/11)-1)*11)}s.computeVertexNormals();let f=9;for(let v=0;v<f;v++){let g=_=>Ke(i,new e.ShaderMaterial({uniforms:{uCover:{value:null},uHasCover:{value:0},uBrightness:{value:1},uReflection:{value:_?1:0}},vertexShader:py,transparent:_,depthWrite:!_,side:e.DoubleSide,fragmentShader:`uniform sampler2D uCover;uniform float uHasCover,uBrightness,uReflection;varying vec2 vUv;
      void main(){vec2 p=vUv-.5;float d=length(p),groove=.5+.5*sin(d*220.0);
      vec3 empty=mix(vec3(.035,.06,.07),vec3(.16,.28,.29),1.0-smoothstep(.05,.5,d))*(.8+groove*.1);
      vec3 c=mix(empty,texture2D(uCover,vUv).rgb,uHasCover)*uBrightness;
      float alpha=mix(1.0,pow(vUv.y,2.0)*.2,uReflection);gl_FragColor=vec4(c,alpha);
      #include <colorspace_fragment>
      }`})),m=new e.Mesh(s,g(!1)),y=new e.Mesh(s,g(!0));t.add(m,y),o.push(m),a.push(y),l.push(null),c.push("")}let h=!1;function d(){h||(h=!0,l.forEach(v=>n.cover.release(v)),r&&n.dispose())}i.scope.defer(d);function p(v,g){let m=i.services.coverItems,y=(typeof m=="function"?m():m)||[],_=i.services.coverUrl,x=(typeof _=="function"?_():_)||v.coverUrl||"",S=y.map(A=>typeof A=="string"?A:A?.coverUrl||A?.cover||A?.url||"").filter(Boolean);x&&!S.includes(x)&&S.unshift(x);let b=Math.max(0,S.indexOf(x)),E=(b+Math.round(g.coverIndex||0))%Math.max(1,S.length),M=g.radius??11,T=v.sceneTime??v.time??0;for(let A=0;A<f;A++){let I=A-4,D=o[A],B=a[A],F=S.length?S[((E+I)%S.length+S.length)%S.length]:"",L=I*.34;D.position.set(Math.sin(L)*M,0,-M+Math.cos(L)*M-2),D.rotation.y=L,D.position.y+=Math.sin(T*.4+A)*.035*(g.speed??.6),D.scale.setScalar((I===0?1.12:1)*(1+Ut(v,"bass")*.012*(g.reactivity??.7))),B.position.copy(D.position),B.position.y=-3.15-D.position.y,B.rotation.copy(D.rotation),B.scale.set(D.scale.x,-D.scale.y,1),c[A]!==F&&(n.cover.release(l[A]),c[A]=F,l[A]=n.cover.acquire(F,i.signal));let U=l[A]?.texture||null;for(let X of[D,B])X.material.uniforms.uCover.value=U,X.material.uniforms.uHasCover.value=U?1:0,X.material.uniforms.uBrightness.value=I===0?1:Math.max(.35,.8-Math.abs(I)*.1)}t.scale.setScalar(g.scale??1)}return yn(t,i.params,i.quality,{update:p,dispose:d,stats:()=>({covers:l.filter(Boolean).length,drawCalls:18,triangles:864,...n.stats()})})}var gy=`
uniform float uTime,uBass;
varying vec3 vNormal,vSurface;
void main(){vSurface=normalize(position);vNormal=normalize(normalMatrix*normal);
 float wave=sin(vSurface.y*8.0+uTime*.3)*cos(vSurface.x*6.0-uTime*.2);
 vec3 p=position+normal*wave*uBass*.035;
 gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}`,vy=`
uniform sampler2D uCover;uniform float uHasCover;
varying vec3 vNormal,vSurface;
vec3 art(){
 vec3 n=normalize(vSurface);float arc=acos(clamp(abs(n.z),0.0,1.0));
 // Arc-length projection keeps artwork continuous across the curved surface.
 vec2 direction=n.xy/max(length(n.xy),.0001);
 vec2 uv=clamp(.5+direction*arc/2.05,.002,.998);
 vec3 fallback=mix(vec3(.025,.06,.08),vec3(.14,.23,.25),uv.y);
 return mix(fallback,texture2D(uCover,uv).rgb,uHasCover);
}`,r3=vy+`
void main(){
 vec3 n=normalize(vNormal),l=normalize(vec3(-.4,.65,1.0));
 float diffuse=max(0.0,dot(n,l));float rim=pow(1.0-max(n.z,0.0),3.0);
 float spec=pow(max(0.0,dot(n,normalize(l+vec3(0,0,1)))),90.0);
 float grain=sin(vSurface.x*1100.0)*sin(vSurface.y*1100.0)*.006;
 vec3 c=art()*(.62+.42*diffuse+grain)+vec3(.8,.92,1.0)*spec*.16;
 c+=mix(art(),vec3(.52,.72,.78),.35)*rim*.18;
 gl_FragColor=vec4(c,1.0);
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}`,s3=vy+`
void main(){float edge=pow(1.0-abs(normalize(vNormal).z),4.0);
 gl_FragColor=vec4(mix(art(),vec3(.52,.75,.8),.3),edge*.17);
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}`;function xy(i){let e=i.THREE,t=xn(i),n=new e.Group;t.add(n);let r=i.services.spatialResources||Ei(e),s=!i.services.spatialResources,o={uCover:{value:null},uHasCover:{value:0},uTime:{value:0},uBass:{value:0}},a=Ke(i,new e.SphereGeometry(3.2,96,64));n.add(new e.Mesh(a,Ke(i,new e.ShaderMaterial({uniforms:o,vertexShader:gy,fragmentShader:r3}))));let l=new e.Mesh(Ke(i,new e.SphereGeometry(3.26,48,32)),Ke(i,new e.ShaderMaterial({uniforms:o,vertexShader:gy,fragmentShader:s3,side:e.BackSide,transparent:!0,depthWrite:!1})));n.add(l);let c=1e4,u=new Float32Array(c*3);for(let S=0;S<c;S++){let b=1-2*(S+.5)/c,E=Math.sqrt(1-b*b),M=S*2.39996323;u.set([Math.cos(M)*E*3.207,b*3.207,Math.sin(M)*E*3.207],S*3)}let f=Ke(i,new e.BufferGeometry);f.setAttribute("position",new e.BufferAttribute(u,3));let h=Ke(i,new e.PointsMaterial({color:15005168,size:.012,transparent:!0,opacity:.13,depthWrite:!1}));n.add(new e.Points(f,h));let d=null,p="",v=i.quality,g=i.params,m=!1,y=16/9;function _(){f.setDrawRange(0,Math.floor(c*ti(v)*(g.density??1)))}function x(){m||(m=!0,r.cover.release(d),s&&r.dispose())}return i.scope.defer(x),_(),yn(t,g,v,{update(S,b){let E=i.services.coverUrl,M=(typeof E=="function"?E():E)||S.coverUrl||"";M!==p&&(r.cover.release(d),p=M,d=r.cover.acquire(M,i.signal)),o.uCover.value=d?.texture||null,o.uHasCover.value=d?.texture?1:0;let T=(S.sceneTime??S.time??0)*(b.speed??.6);o.uTime.value=T,o.uBass.value=Ut(S,"bass")*(b.reactivity??.7),n.rotation.set(Math.sin(T*.16)*.035,Math.sin(T*.12)*.16,Math.sin(T*.09)*.025);let A=1+Math.sin(T*.7)*.003+Ut(S,"bass")*.012*(b.reactivity??.7);n.scale.setScalar(A*Math.min(1,y/.95)),t.scale.setScalar(b.scale??1)},params(S){g=S,_()},quality(S){v=S,_()},resize(S,b){y=S/Math.max(1,b)},dispose:x,stats:()=>({covers:d?.texture?1:0,particles:f.drawRange.count,drawCalls:3,triangles:15168})})}var o3=`
attribute vec2 aCover;
uniform sampler2D uCover,uPrevious;
uniform float uHasCover,uMix,uTime,uBass,uMid,uTreble,uRelief,uPointSize,uFocal,uSpacing;
varying vec3 vColor;varying float vLight;
${Ed}
${qa}
void main(){
 vec3 fallback=mix(vec3(.09,.32,.36),vec3(.84,.36,.48),aCover.x);
 fallback=mix(fallback,vec3(.83,.78,.59),smoothstep(.1,1.0,aCover.y)*.6);
 vec3 art=mix(texture2D(uPrevious,aCover).rgb,texture2D(uCover,aCover).rgb,uMix);
 vColor=mix(fallback,art,uHasCover);
 float luminance=dot(vColor,vec3(.2126,.7152,.0722));
 vec3 p=position;
 float broad=particleNoise(vec3(p.xy*.52,uTime*.32));
 float detail=particleNoise(vec3(p.xy*1.65,uTime*.57));
 p.z+=(luminance-.45)*uRelief*.22;
 p.z+=(broad*uBass*.42+detail*uMid*.24+sin(p.x*7.0+p.y*6.0+uTime*2.1)*uTreble*.055)*uRelief;
 vec3 deformed=indentParticle(p);
 float dent=dot(p-deformed,uPointerNormal);
 p=deformed;
 vLight=1.0-dent*.16+(detail*uMid)*.04;
 vec4 mv=modelViewMatrix*vec4(p,1.0);
 // Cover-sized spacing keeps a legible grid at every geometry and DPR tier.
 gl_PointSize=clamp(uSpacing*uFocal*uPointSize*length(modelViewMatrix[0].xyz)/max(.5,-mv.z),.8,11.0);
 gl_Position=projectionMatrix*mv;
}`,a3=`
varying vec3 vColor;varying float vLight;
void main(){
 float r=length(gl_PointCoord-.5)*2.0;if(r>1.0)discard;
 float alpha=1.0-smoothstep(.64,1.0,r);
 gl_FragColor=vec4(vColor*vLight,alpha*.98);
 #include <colorspace_fragment>
}`;function yy(i){let e=i.THREE,t=xn(i),n=new e.Group;t.add(n);let r=192,s=new Float32Array(r*r*3),o=new Float32Array(r*r*2),a=Ke(i,new e.BufferGeometry);a.setAttribute("position",new e.BufferAttribute(s,3)),a.setAttribute("aCover",new e.BufferAttribute(o,2));let l=Xa(i,n,{surface:!0,radius:1.15}),c={...l.uniforms,uCover:{value:null},uPrevious:{value:null},uHasCover:{value:0},uMix:{value:1},uTime:{value:0},uBass:{value:0},uMid:{value:0},uTreble:{value:0},uRelief:{value:1},uPointSize:{value:1},uSpacing:{value:8/r},uFocal:{value:700}},u=Ke(i,new e.ShaderMaterial({uniforms:c,vertexShader:o3,fragmentShader:a3,transparent:!0,depthWrite:!0,blending:e.NormalBlending})),f=new e.Points(a,u);f.frustumCulled=!1,n.add(f);let h=i.services.spatialResources||Ei(e),d=!i.services.spatialResources,p=null,v=null,g="",m=i.quality,y=i.params,_=0,x=16/9,S=900,b=!1;function E(){let T={low:96,medium:144,high:r}[m?.mode]||144,A=Math.max(32,Math.floor(T*Math.sqrt(y.density??1)));if(A!==_){_=A;for(let I=0;I<_;I++)for(let D=0;D<_;D++){let B=I*_+D,F=(D+.5)/_,L=(I+.5)/_;s.set([(F-.5)*8,(L-.5)*8,Math.sin(F*6.28)*.012],B*3),o.set([F,L],B*2)}a.attributes.position.needsUpdate=!0,a.attributes.aCover.needsUpdate=!0,a.setDrawRange(0,_*_),c.uSpacing.value=8/_}}function M(){b||(b=!0,h.cover.release(p),h.cover.release(v),d&&h.dispose())}return i.scope.defer(M),E(),yn(t,y,m,{update(T,A){let I=i.services.coverUrl,D=(typeof I=="function"?I():I)||T.coverUrl||"";D!==g&&(h.cover.release(v),v=null,p?.texture?v=p:h.cover.release(p),g=D,p=h.cover.acquire(D,i.signal),c.uMix.value=0,D||(h.cover.release(v),v=null)),p?.failed&&(h.cover.release(v),v=null);let B=p?.texture||v?.texture;c.uCover.value=B||null,c.uPrevious.value=v?.texture||B||null,c.uHasCover.value=B?1:0,p?.texture&&(c.uMix.value=T.playing===!1||T.reduced||!v?1:Math.min(1,c.uMix.value+(T.dt||0)*3),c.uMix.value===1&&v&&(h.cover.release(v),v=null,c.uPrevious.value=B));let F=(T.sceneTime??T.time??0)*(A.speed??.6);c.uTime.value=F,c.uBass.value=Ut(T,"bass")*(A.reactivity??.7),c.uMid.value=Ut(T,"mid")*(A.reactivity??.7),c.uTreble.value=Ut(T,"treble")*(A.reactivity??.7),c.uRelief.value=A.relief??1,c.uPointSize.value=A.pointSize??1,c.uFocal.value=S*(i.renderer?.getPixelRatio()||1)*i.camera.projectionMatrix.elements[5]*.5,n.scale.setScalar(Math.min(1,x/1.08)),n.rotation.set(Math.sin(F*.15)*.018,Math.sin(F*.12)*.035,0),t.scale.setScalar((A.scale??1)*(A.cue==="chorus"?1.08:1)),t.rotation.set(A.cue==="bridge"?.06:0,0,A.director?Math.sin((T.sceneTime??0)*.08)*.04:0),l.update(T,A.pointerStrength??1)},resize(T,A){x=T/Math.max(1,A),S=A},params(T){y=T,E()},quality(T){m=T,E()},dispose:M,stats:()=>({particles:_*_,drawCalls:1,covers:+!!p?.texture+ +!!v?.texture})})}var Or=Math.PI*2,l3=187/360,c3=1.6,u3=.42,h3=.6,_y=.9,f3=.6,Fu=24,v0=Object.freeze([Object.freeze({id:"torus",label:"\u73AF\u9762"}),Object.freeze({id:"sphere",label:"\u7403\u58F3"}),Object.freeze({id:"gyro",label:"\u53CC\u73AF"}),Object.freeze({id:"helix",label:"\u87BA\u65CB"})]),Id=Object.freeze([Object.freeze({id:"front",label:"\u6B63\u9762",yaw:0,pitch:0,dist:1,fov:0}),Object.freeze({id:"high",label:"\u4FEF\u77B0",yaw:.2,pitch:.36,dist:1.1,fov:-2}),Object.freeze({id:"sweep",label:"\u4FA7\u63A0",yaw:.7,pitch:.08,dist:.94,fov:3}),Object.freeze({id:"close",label:"\u8D34\u8FD1",yaw:-.24,pitch:-.05,dist:.8,fov:-5})]);function d3(i){let e=2166136261;for(let t=0;t<i.length;t++)e^=i.charCodeAt(t),e=Math.imul(e,16777619);return e^=e>>>16,e=Math.imul(e,2246822507),e^=e>>>13,e=Math.imul(e,3266489909),e^=e>>>16,e>>>0}function m0(i,e){if(!i)return{id:"",hue:l3,shell:0,shot:0};let t=d3(String(i));return{id:String(i),hue:Number.isFinite(e)?e:t%3600/3600,shell:(t>>>12)%v0.length,shot:(t>>>20)%Id.length}}function p3(i){let e=new Float64Array(36),t=new Float64Array(36),n=new Float64Array(36);for(let l=0;l+2<i.length;l+=4){let c=i[l]/255,u=i[l+1]/255,f=i[l+2]/255,h=Math.max(c,u,f),d=Math.min(c,u,f),p=h?(h-d)/h:0;if(h<.12||p<.18)continue;let v=h===c?(u-f)/(h-d):h===u?2+(f-c)/(h-d):4+(c-u)/(h-d);v=(v/6%1+1)%1;let g=p*p*h,m=Math.floor(v*36)%36;e[m]+=g,t[m]+=Math.cos(v*Or)*g,n[m]+=Math.sin(v*Or)*g}let r=-1,s=0;for(let l=0;l<36;l++){let c=e[(l+35)%36]+e[l]+e[(l+1)%36];c>s&&(s=c,r=l)}if(r<0||s<.5)return null;let o=0,a=0;for(let l of[(r+35)%36,r,(r+1)%36])o+=t[l],a+=n[l];return(Math.atan2(a,o)/Or%1+1)%1}var co=new Map;function m3(i,e){for(co.delete(i),co.set(i,e);co.size>128;)co.delete(co.keys().next().value)}function g3(i,e){let t=[],n=new Set,r=new Map,s=new Set,o=null;function a(c,u){let f=o;o=null,n.delete(f.key),!i.signal.aborted&&(r.get(f.id)===f.url&&(u?s.add(f.key):m3(f.key,c),e()),l())}function l(){if(!(o||i.signal.aborted))for(;t.length;){let c=t.shift();if(r.get(c.id)!==c.url){n.delete(c.key);continue}let u=new Image;o={...c,img:u},u.crossOrigin="anonymous",u.decoding="async",u.onload=()=>{if(o?.img===u)try{let h=document.createElement("canvas");h.width=h.height=24;let d=h.getContext("2d",{willReadFrequently:!0});d.drawImage(u,0,0,24,24),a(p3(d.getImageData(0,0,24,24).data),!1)}catch{a(null,!0)}},u.onerror=()=>{o?.img===u&&a(null,!0)};let f=i.services.resolveCover;Promise.resolve().then(()=>f?f(c.url):c.url).then(h=>{o?.img===u&&(h?u.src=h:a(null,!0))},()=>{o?.img===u&&a(null,!0)});break}}return i.scope.defer(()=>{o&&(o.img.onload=o.img.onerror=null,o=null),t.length=0,n.clear()}),{request(c,u){if(!c)return;r.set(c,u||""),o?.id===c&&o.url!==u&&(o.img.onload=o.img.onerror=null,n.delete(o.key),o=null);let f=c+`
`+u;if(!u||co.has(f)||n.has(f)||s.has(f)||typeof Image>"u"||typeof document>"u"){l();return}for(n.add(f),t.push({id:c,url:u,key:f});t.length>Fu+2;)n.delete(t.shift().key);for(;r.size>128;)r.delete(r.keys().next().value);l()},hue(c){let u=co.get(c+`
`+r.get(c));return u??void 0},pending:c=>n.has(c+`
`+r.get(c))}}var v3=`
attribute vec4 aSeed;
uniform float uTime,uEnergy,uBurst,uPixel,uMorph,uScatter,uSize,uShellWeights[4];
uniform vec3 uBurstPoint,uColorA,uColorB,uColorC;
varying vec3 vColor;varying float vAlpha;
${qa}
const float TAU=6.2831853;
vec3 shell(float k,vec4 s){
 float u=s.x*TAU,v=s.y*TAU;
 if(k<.5){
  float R=3.25+(s.z-.5)*.75,tube=1.08*pow(s.w,.58);
  vec3 p=vec3((R+tube*cos(v))*cos(u),tube*sin(v)*.78,(R+tube*cos(v))*sin(u));
  return vec3(p.x,p.y*.913-p.z*.408,p.y*.408+p.z*.913);
 }
 if(k<1.5){
  float y=1.0-2.0*s.y,r=sqrt(max(0.0,1.0-y*y)),R=3.2+(s.z-.5)*.45+pow(s.w,3.0)*.95;
  return vec3(cos(u)*r,y,sin(u)*r)*R;
 }
 if(k<2.5){
  bool outer=s.z<.55;float R=outer?3.15:2.2,tube=(outer?.6:.42)*pow(s.w,.6);
  vec3 p=vec3((R+tube*cos(v))*cos(u),tube*sin(v),(R+tube*cos(v))*sin(u));
  if(outer)return vec3(p.x,p.y*.94-p.z*.34,p.y*.34+p.z*.94);
  return vec3(p.x*.8-p.z*.6,p.y*.6+(p.x*.6+p.z*.8)*.8,-p.y*.8+(p.x*.6+p.z*.8)*.6);
 }
 float t=s.y*2.0-1.0,a=t*TAU*1.25+step(.5,s.z)*3.1415927,tube=.55*pow(s.w,.7);
 vec3 center=vec3(cos(a)*2.45,t*3.5,sin(a)*2.45);
 return center+vec3(cos(a)*cos(v),sin(v)*.8,sin(a)*cos(v))*tube;
}
void main(){
 vec3 p=shell(0.0,aSeed)*uShellWeights[0]+shell(1.0,aSeed)*uShellWeights[1]
       +shell(2.0,aSeed)*uShellWeights[2]+shell(3.0,aSeed)*uShellWeights[3];
 vec3 n=normalize(p+vec3(.001));
 p+=n*sin(p.x*1.7+uTime*2.2+aSeed.x*8.0)*.08*(1.0+uEnergy*2.2);
 p+=n*pow(uEnergy,3.0)*sin(aSeed.x*81.0+uTime*3.0)*.45;
 p+=n*uScatter*(.6+aSeed.z*2.2);
 vec3 d=p-uBurstPoint;p+=normalize(d+vec3(.001))*uBurst*exp(-length(d)*.55)*1.4;
 p=indentParticle(p);
 vec4 view=modelViewMatrix*vec4(p,1.0);gl_Position=projectionMatrix*view;
 float size=.7+pow(fract(aSeed.x*13.17+aSeed.y*7.31),3.0)*2.8;
 gl_PointSize=clamp(size*uSize*uPixel*(22.0/max(.5,-view.z))*(1.0+uEnergy*.7),1.0,14.0);
 float slot=fract(aSeed.x*7.31+aSeed.z*3.17);
 vColor=(slot<.16?uColorC:slot<.55?uColorB:uColorA)*(.72+fract(aSeed.y*5.7)*.28);
 float pulse=sin(aSeed.x*20.0+uTime*1.4);vAlpha=.38+.62*pulse*pulse;
}`,x3=`
varying vec3 vColor;varying float vAlpha;
void main(){vec2 p=gl_PointCoord-.5;float d=length(p);if(d>.5)discard;
 float core=smoothstep(.18,0.0,d),glow=smoothstep(.5,.05,d);
 gl_FragColor=vec4(vColor*(glow+core*1.8),(glow*.68+core)*vAlpha);
 #include <colorspace_fragment>
}`,y3="varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",_3=`
uniform vec3 uColor;uniform float uOpacity;varying vec2 vUv;
void main(){float d=length(vUv-.5)*2.0;if(d>1.0)discard;
 float core=exp(-d*d*28.0),halo=exp(-d*d*5.0)*.42,tail=(1.0-smoothstep(.45,1.0,d))*.12;
 gl_FragColor=vec4(mix(uColor,vec3(1.0),core*.8),(core*.85+halo+tail)*uOpacity);
 #include <colorspace_fragment>
}`,M3=`
attribute vec3 aColor;attribute float aSize;uniform float uFocal;varying vec3 vColor;
void main(){vColor=aColor;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*mv;
 gl_PointSize=clamp(aSize*uFocal/max(.5,-mv.z),2.0,96.0);}`,S3=`
varying vec3 vColor;
void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;
 float core=smoothstep(.2,0.0,d),glow=smoothstep(.5,0.0,d);
 gl_FragColor=vec4(vColor*(glow*.8+core*1.6),glow*.55+core);
 #include <colorspace_fragment>
}`,b3=(i,e)=>((e-i)%1+1.5)%1-.5,Pd=(i,e)=>1-Math.exp(-i/e),g0=(i,e,t)=>Math.max(e,Math.min(t,i));function My(i){let e=i.THREE,t=xn(i),n=new e.Group;t.add(n);let r=i.scene.fog;i.scene.fog=new e.FogExp2(197637,.03),i.scope.defer(()=>{i.scene.fog=r||null});let s=new e.Color,o=new e.Color,a=new e.Color,l=new e.Color,c=new e.Color(1,1,1),u=(N,k={})=>Ke(i,new N({transparent:!0,depthWrite:!1,blending:e.AdditiveBlending,...k})),f=9e3,h=new Float32Array(f*3),d=new Float32Array(f*4);for(let N=0;N<f;N++){let k=[en(N,1),en(N,2),en(N,3),en(N,4)],W=k[0]*Or,ye=k[1]*Or,Ie=3.25+(k[2]-.5)*.75,Ue=1.08*Math.pow(k[3],.58);h.set([(Ie+Ue*Math.cos(ye))*Math.cos(W),Ue*Math.sin(ye)*.78,(Ie+Ue*Math.cos(ye))*Math.sin(W)],N*3),d.set(k,N*4)}let p=Ke(i,new e.BufferGeometry);p.setAttribute("position",new e.BufferAttribute(h,3)),p.setAttribute("aSeed",new e.BufferAttribute(d,4));let v=new e.Group;n.add(v);let g=Xa(i,v,{radius:1.6}),m=new Float32Array([1,0,0,0]),y=m.slice(),_=m.slice(),x={...g.uniforms,uTime:{value:0},uEnergy:{value:.35},uBurst:{value:0},uPixel:{value:1},uShellWeights:{value:m},uMorph:{value:1},uScatter:{value:0},uSize:{value:1},uBurstPoint:{value:new e.Vector3},uColorA:{value:s},uColorB:{value:o},uColorC:{value:a}},S=new e.Points(p,Ke(i,new e.ShaderMaterial({uniforms:x,vertexShader:v3,fragmentShader:x3,transparent:!0,depthWrite:!1,blending:e.AdditiveBlending})));S.frustumCulled=!1,v.add(S);let b=Ke(i,new e.PlaneGeometry(1,1)),E=N=>{let k=Ke(i,new e.ShaderMaterial({uniforms:{uColor:{value:new e.Color},uOpacity:{value:N}},vertexShader:y3,fragmentShader:_3,transparent:!0,depthWrite:!1,blending:e.AdditiveBlending})),W=new e.Mesh(b,k);return W.frustumCulled=!1,t.add(W),W},M=E(.5),T=E(.26),A=Ke(i,new e.MeshBasicMaterial({wireframe:!0,transparent:!0,opacity:.3})),I=new e.Mesh(Ke(i,new e.IcosahedronGeometry(1.32,2)),A);n.add(I);let D=Ke(i,new e.MeshBasicMaterial({wireframe:!0,transparent:!0,opacity:.72})),B=new e.Mesh(Ke(i,new e.IcosahedronGeometry(.72,1)),D);n.add(B);let F=u(e.MeshBasicMaterial,{opacity:0,side:e.DoubleSide}),L=new e.Mesh(Ke(i,new e.RingGeometry(2.9,2.96,128)),F);L.position.z=1.4,n.add(L);let U=[];for(let N=0;N<7;N++){let k=[];for(let ye=0;ye<180;ye++){let Ie=ye/180*Or,Ue=2.1+N*.44+Math.sin(Ie*(3+N)+N)*.06;k.push(new e.Vector3(Math.cos(Ie)*Ue,Math.sin(Ie*(2+N%2))*.12,Math.sin(Ie)*Ue))}let W=new e.LineLoop(Ke(i,new e.BufferGeometry().setFromPoints(k)),u(e.LineBasicMaterial,{opacity:.14+N*.025}));W.userData.base=[(N-3)*.16,N*.38,N*.13],W.userData.accent=N%3===0,U.push(W),n.add(W)}let X=new e.Group;n.add(X);let te=[[],[]];for(let N=0;N<180;N++){let k=N/180*Or,W=5.35,ye=W+(N%15===0?.5:N%5===0?.26:.11);te[N%15===0?1:0].push(Math.cos(k)*W,0,Math.sin(k)*W,Math.cos(k)*ye,0,Math.sin(k)*ye)}let Z=te.map(()=>u(e.LineBasicMaterial,{opacity:.4}));te.forEach((N,k)=>{let W=Ke(i,new e.BufferGeometry);W.setAttribute("position",new e.Float32BufferAttribute(N,3)),X.add(new e.LineSegments(W,Z[k]))});let K=u(e.MeshBasicMaterial,{opacity:.35}),j=u(e.MeshBasicMaterial,{opacity:.22}),ne=new e.Mesh(Ke(i,new e.TorusGeometry(4.15,.012,6,140)),K);ne.rotation.x=Math.PI/2,n.add(ne);let ie=new e.Mesh(Ke(i,new e.TorusGeometry(3.55,.01,6,140)),j);ie.rotation.x=Math.PI/2,n.add(ie);let We=u(e.MeshBasicMaterial,{opacity:.028,side:e.DoubleSide}),Fe=new e.Mesh(Ke(i,new e.CylinderGeometry(.25,4.6,9.5,48,1,!0)),We);Fe.position.y=-.2,n.add(Fe);let Ye=[];for(let N=0;N<64;N++){let k=N/64*Or,W=5.05+N%4*.06,ye=.4+en(N,9)*1.6;Ye.push(Math.cos(k)*W,-2.2,Math.sin(k)*W,Math.cos(k)*W,-2.2+ye,Math.sin(k)*W)}let $=Ke(i,new e.BufferGeometry);$.setAttribute("position",new e.Float32BufferAttribute(Ye,3));let oe=u(e.LineBasicMaterial,{opacity:.28}),Ce=new e.LineSegments($,oe);n.add(Ce);let He=1800,Ee=new Float32Array(He*3);for(let N=0;N<He;N++)Ee.set([(en(N,11)-.5)*50,(en(N,12)-.5)*28,-8-en(N,13)*55],N*3);let ze=Ke(i,new e.BufferGeometry);ze.setAttribute("position",new e.BufferAttribute(Ee,3));let pt=Ke(i,new e.PointsMaterial({size:.035,transparent:!0,opacity:.5,depthWrite:!1})),ae=new e.Points(ze,pt);ae.frustumCulled=!1,t.add(ae);let xe=[];for(let N=0;N<=60;N++){let k=N-30;xe.push(-30,0,k,30,0,k,k,0,-30,k,0,30)}let we=Ke(i,new e.BufferGeometry);we.setAttribute("position",new e.Float32BufferAttribute(xe,3));let Ae=Ke(i,new e.LineBasicMaterial({transparent:!0,opacity:.34})),Te=new e.LineSegments(we,Ae);Te.position.y=-4.1,t.add(Te);let de=u(e.MeshBasicMaterial,{opacity:.22,side:e.DoubleSide}),Oe=u(e.MeshBasicMaterial,{opacity:.16,side:e.DoubleSide}),Re=new e.Mesh(Ke(i,new e.RingGeometry(4.4,4.46,128)),de);Re.rotation.x=-Math.PI/2,Re.position.y=-4.08,t.add(Re);let Je=new e.Mesh(Ke(i,new e.RingGeometry(5.15,5.18,128)),Oe);Je.rotation.x=-Math.PI/2,Je.position.y=-4.08,t.add(Je);let z=new Float32Array(Fu*3),lt=new Float32Array(Fu*3),rt=new Float32Array(Fu),P=Ke(i,new e.BufferGeometry);P.setAttribute("position",new e.BufferAttribute(z,3)),P.setAttribute("aColor",new e.BufferAttribute(lt,3)),P.setAttribute("aSize",new e.BufferAttribute(rt,1)),P.setDrawRange(0,0);let w={uFocal:{value:700}},q=new e.Points(P,Ke(i,new e.ShaderMaterial({uniforms:w,vertexShader:M3,fragmentShader:S3,transparent:!0,depthWrite:!1,blending:e.AdditiveBlending})));q.frustumCulled=!1,n.add(q);let J=i.quality,G=i.params,re=1280,Q=720,V=null,ee=null,le=m0("",null),Se="",me=le.hue,_e=le.hue,ce=0,fe=0,De=1,O=1,Me=0,se=0,Pe=.35,Be=10,ue=null,je={yaw:0,pitch:0,dist:1,fov:0},Ze=new e.Vector2,Mt="",ct=[],Vt=[],kt=-1,ni=null,ii=null,Hi=0,Wi=-1,ri="",vi=g3(i,()=>{Hi++,i.services.invalidate?.()}),cr=new e.Raycaster,Yn=new e.Vector2,Ci=new e.Plane,xi=new e.Vector3,Xi=new e.Vector3,Zn=new e.Vector3,qi=new e.Quaternion,yi=new e.Quaternion;function Ri(){p.setDrawRange(0,Math.floor(f*ti(J)*(G.density??1))),ze.setDrawRange(0,Math.floor(He*ti(J)))}Ri();function ur(N){s.setHSL((N%1+1)%1,.9,.66),o.setHSL(((N+.12)%1+1)%1,.85,.62),a.setHSL(((N-.395)%1+1)%1,.95,.67),l.setHSL((N%1+1)%1,.55,.26),A.color.copy(s).lerp(c,.35),D.color.copy(a),F.color.copy(a),K.color.copy(s),j.color.copy(a),We.color.copy(s).multiplyScalar(.6),oe.color.copy(l),U.forEach(k=>k.material.color.copy(k.userData.accent?a:s)),Z[0].color.copy(s),Z[1].color.copy(a),pt.color.copy(l).lerp(c,.25),Ae.color.copy(l),de.color.copy(s),Oe.color.copy(a),M.material.uniforms.uColor.value.copy(s).multiplyScalar(.55),T.material.uniforms.uColor.value.copy(a)}function Yi(N){return vi.hue(N)}function Bt(N,k,W){let ye=N.id!==le.id||N.shell!==le.shell||N.shot!==le.shot;fe!==N.shell&&(y.set(m),_.fill(0),_[N.shell]=1,fe=N.shell,De=0),ye&&N.id!==le.id&&(se=x.uScatter.value,O=0,Me=W?.45:.9,!W&&N.id&&(Be=0)),le=N,k&&(m.fill(0),m[N.shell]=1,y.set(m),_.set(m),fe=N.shell,De=1,O=1)}function ho(N){let k=[le.id,Math.round(le.hue*360),le.shell,le.shot,N?1:0].join("|");k!==Se&&(Se=k,i.services.onRecipe?.({id:le.id,preview:!!N,hue:Math.round(le.hue*360),shell:v0[le.shell].label,shot:Id[le.shot].label}))}function us(N,k,W){let ye=N.slice(0,Fu),Ie=ye.map(Ne=>Ne.id+"|"+(Ne.cover||"")).join(`
`)+"|"+k;for(let Ne of ye)Ne.id!==k&&Ne.id!==W&&vi.request(Ne.id,Ne.cover);if(Ie===Mt&&Wi===Hi)return;Mt=Ie,Wi=Hi,ct=ye;let Ue=new e.Color;ye.forEach((Ne,Y)=>{Ue.setHSL(m0(Ne.id,Yi(Ne.id)).hue,.85,Ne.id===k?.82:.64).toArray(lt,Y*3)}),P.attributes.aColor.needsUpdate=!0,P.setDrawRange(0,ye.length),kt>=ye.length&&(kt=-1)}function Tn(N){if(!V)return;let k=i.camera;if(V.position)k.position.fromArray(V.position),k.rotation.set(V.pitch,V.yaw,V.roll,"YXZ"),k.fov=V.fov;else{let W=V.yaw+je.yaw,ye=g0(V.pitch+je.pitch,-1.2,1.2),Ie=Math.max(2.5,V.dist*je.dist-N*.6),Ue=Math.cos(ye);k.position.set(V.tx+Math.sin(W)*Ue*Ie,V.ty+Math.sin(ye)*Ie,V.tz+Math.cos(W)*Ue*Ie),k.lookAt(V.tx,V.ty,V.tz),k.rotateZ(V.roll),k.fov=g0(V.fov+je.fov,20,90)}k.updateProjectionMatrix()}function C(N){let k=N.pointer;if(!k?.active||!Vt.length||!Number.isFinite(k.x)||!Number.isFinite(k.y))return-1;let W=-1,ye=18;for(let Ie=0;Ie<Vt.length;Ie++){if(Zn.fromArray(z,Ie*3).applyMatrix4(q.matrixWorld).project(i.camera),Zn.z>1)continue;let Ue=Math.hypot((Zn.x-k.x)*re/2,(Zn.y-k.y)*Q/2);Ue<ye&&(ye=Ue,W=Ie)}return W}function H(N){Yn.set(N.x,N.y),i.camera.updateMatrixWorld(),cr.setFromCamera(Yn,i.camera),i.camera.getWorldDirection(Xi).negate(),n.updateMatrixWorld(!0),Ci.setFromNormalAndCoplanarPoint(Xi,n.getWorldPosition(xi)),cr.ray.intersectPlane(Ci,xi)&&(v.worldToLocal(xi),x.uBurstPoint.value.copy(xi)),Be=0}return Object.assign(yn(t,G,J,{update(N,k){let W=Number.isFinite(N.now)?N.now:0,ye=!!N.reduced,Ie=ye||ee===null?0:g0((W-ee)/1e3,0,.1);ee=W;let Ue=(k.speed??.6)/.6,Ne=(N.sceneTime??N.time??0)*Ue,Y=N.track||{},ve=k.queuePreview!==!1&&k.trackRecipes!==!1?N.preview:null;ri=Y.id?String(Y.id):"",vi.request(ri,Y.cover||(typeof i.services.coverUrl=="function"?i.services.coverUrl():"")),ve?.id&&vi.request(String(ve.id),ve.cover);let Le=typeof i.services.queue=="function"?i.services.queue()||[]:[];us(Le,ri,ve?.id);let ge=!!(ve?.id&&String(ve.id)!==ri),qe=k.trackRecipes===!1?"":ge?String(ve.id):ri,$e=m0(qe,Yi(qe));$e.id!==le.id&&(ce=0),$e.id&&Yi($e.id)===void 0&&vi.pending($e.id)&&ce<f3&&!ye&&(ce+=Ie,$e.hue=le.id===$e.id?le.hue:_e),Bt($e,ye,ge),_e=$e.hue,ho(ge);let tt=Id[le.shot];if(ye)me=_e,Object.assign(je,{yaw:tt.yaw,pitch:tt.pitch,dist:tt.dist,fov:tt.fov});else{me=((me+b3(me,_e)*Pd(Ie,u3))%1+1)%1;for(let nt of["yaw","pitch","dist","fov"])je[nt]+=(tt[nt]-je[nt])*Pd(Ie,h3);De=Math.min(1,De+Ie/c3),O=Math.min(1,O+Ie/_y)}ur(me);let st=De*De*(3-2*De);for(let nt=0;nt<m.length;nt++)m[nt]=y[nt]*(1-st)+_[nt]*st;x.uMorph.value=De,x.uScatter.value=O<1?se*(1-O)+Math.sin(O*Math.PI)*Me:0,n.updateMatrixWorld(!0);let It=N.pointer?.active&&!N.pointer.dragging&&k.queuePreview!==!1&&k.trackRecipes!==!1,ke=It&&ii&&Math.hypot(N.pointer.x-ii.x,N.pointer.y-ii.y)<.001,wt=null;if(ke&&ni)wt=ni;else if(It){let nt=C(N);wt=nt>=0?Vt[nt].id:null}kt=ct.findIndex(nt=>nt.id===wt);let ut=kt>=0?wt:null;ut!==ni&&(ni=ut,i.services.previewTrack?.(ni)),ii=It?{x:N.pointer.x,y:N.pointer.y}:null;let Tt=N.pointer?.click;if(ue===null&&(ue=Tt?Tt.serial:0),Tt&&Tt.serial!==ue){ue=Tt.serial;let nt=C({pointer:{active:!0,x:Tt.x,y:Tt.y}}),qt=ni&&ii&&Math.hypot(Tt.x-ii.x,Tt.y-ii.y)<.001?ni:nt>=0?Vt[nt].id:null;qt&&qt!==ri&&ct.some(hr=>hr.id===qt)&&i.services.playTrack?.(qt),ye||H(Tt)}Be+=Ie;let Ot=ye?1:Math.min(1,Be/_y),rn=1-Ot,Un=!ye&&!!N.pointer?.down,xt=Math.min(1,(typeof N.onset=="number"?N.onset:0)*.8+Ut(N,"bass")*.45)*(k.reactivity??.7)/.7,St=Un?1:Math.min(1,.2+xt*.46+rn*.35);Pe=ye?St:Pe+(St-Pe)*Pd(Ie,.2),x.uTime.value=Ne,x.uEnergy.value=Pe,x.uBurst.value=rn*rn,x.uPixel.value=i.renderer?.getPixelRatio()||1,x.uSize.value=k.pointSize??1,!ye&&N.pointer?.active&&Number.isFinite(N.pointer.x)&&Ze.lerp(N.pointer,Pd(Ie,.35)),n.rotation.y=Ne*.075+Ze.x*.2,n.rotation.x=Ze.y*-.11,S.rotation.z=Ne*.035,I.rotation.set(Ne*.18,-Ne*.22,Ne*.08),B.scale.setScalar(1+xt*.12),B.rotation.set(-Ne*.36,Ne*.48,0),L.scale.setScalar(.45+Ot*2.1),F.opacity=Ot<1?(1-Ot)*.42:0,X.rotation.y=-Ne*.03;let yt=.5+.5*Math.sin(Ne*.5);ne.position.y=Math.sin(Ne*.5)*2.6,K.opacity=.16+yt*.24,ie.position.y=Math.sin(Ne*.5+Math.PI)*2.3,j.opacity=.1+(1-yt)*.16,Fe.rotation.y=Ne*.05,Ce.rotation.y=Ne*.02,Re.rotation.z=Ne*.03,Je.rotation.z=-Ne*.02,U.forEach((nt,Xt)=>{let[qt,hr,Ey]=nt.userData.base;nt.rotation.set(qt,hr+(Xt%2?-1:1)*(.048+Xt*.009)*Ne,Ey+.024*Ne)}),ae.position.set(Ze.x*-1.2,Ze.y*-.8,0),ct.forEach((nt,Xt)=>{let qt=Xt/Math.max(1,ct.length)*Or+Ne*(.1+Xt%5*.018),hr=3.5+Xt%3*.65;z.set([Math.cos(qt)*hr,Math.sin(qt*2.4+Xt)*1.35,Math.sin(qt)*hr],Xt*3),rt[Xt]=(nt.id===ri?.9:.5)*(Xt===kt?1.65:1)*(1+xt*.4)}),ct.length&&(P.attributes.position.needsUpdate=!0,P.attributes.aSize.needsUpdate=!0),w.uFocal.value=Q*(i.renderer?.getPixelRatio()||1)*i.camera.projectionMatrix.elements[5]*.5,Tn(Un?Pe:0),i.camera.updateMatrixWorld(),t.updateMatrixWorld(!0),Vt=ct.slice(),t.getWorldQuaternion(yi).invert(),i.camera.getWorldQuaternion(qi),M.quaternion.copy(yi).multiply(qi),T.quaternion.copy(M.quaternion),M.scale.setScalar(7.2+xt*1.3+rn*1.6),T.scale.setScalar(3.1+xt*.9+rn*1.1),g.update(N,(k.pointerStrength??1)*.6)},resize(N,k){re=N,Q=k},params(N){G=N,Ri()},quality(N){J=N,Ri()},stats:()=>({particles:p.drawRange.count+ze.drawRange.count+P.drawRange.count,nodes:ct.length,recipe:{id:le.id,hue:Math.round(le.hue*360),shell:v0[le.shell].id,shot:Id[le.shot].id},morph:De,hover:kt,energy:Pe,yaw:(n.rotation.y*180/Math.PI%360+360)%360,zoom:15/Math.max(1,i.camera.position.length())})}),{setRig(N){V=N}})}var uo={halftone:_t("\u534A\u8C03\u7F51\u70B9",0,0,40,1),grain:_t("\u80F6\u7247\u9897\u7C92",0,0,40,1),vignette:_t("\u955C\u5934\u6697\u89D2",0,0,100,1),softness:_t("\u5149\u6655\u67D4\u5316",0,0,20,1),bokeh:_t("\u7126\u70B9\u865A\u5316",0,0,20,1),chroma:_t("\u5F84\u5411\u8272\u6563",0,0,12,1),aberration:_t("\u955C\u5934\u5149\u5B66\u7455\u75B5",0,0,12,1),distort:_t("\u80F6\u7247\u6563\u7729",0,0,12,1),bloom:_t("\u5BF9\u6BD4\u5EA6\u8F89\u6620",0,0,12,1)},y0={dust:Za.dust,discRing:Za.discRing,ripples:Za.ripples,...uo};function w3(i){let e=i.THREE,t=xn(i),n=1200,r=new Float32Array(n*3);for(let f=0;f<n;f++)r[f*3]=(en(f,1)-.5)*24,r[f*3+1]=(en(f,2)-.5)*16,r[f*3+2]=(en(f,3)-.5)*24;let s=Ke(i,new e.BufferGeometry);s.setAttribute("position",new e.BufferAttribute(r,3));let o=Ke(i,new e.PointsMaterial({color:12377053,size:.035,transparent:!0,opacity:.5,depthWrite:!1})),a=new e.Points(s,o);t.add(a);let l=i.quality,c=i.params;function u(){s.setDrawRange(0,Math.floor(n*ti(l)*(c.dust??0))),t.visible=s.drawRange.count>0}return u(),yn(t,c,l,{update(f,h){t.rotation.y=(h.reduced?0:f.sceneTime??f.time??0)*.013*(h.speed??.6),o.opacity=.35+Ut(f,"treble")*.3},params(f){c=f,u()},quality(f){l=f,u()},stats:()=>({particles:s.drawRange.count,drawCalls:t.visible?1:0})})}function T3(i){let e=i.THREE,t=xn(i),n=64,r=Ke(i,new e.BoxGeometry(.065,1,.065)),s=Ke(i,new e.MeshBasicMaterial({color:16556943})),o=Ke(i,new e.InstancedMesh(r,s,n)),a=new e.Object3D;return t.add(o),t.visible=!!i.params.discRing,yn(t,i.params,i.quality,{update(l,c){if(c.discRing){for(let u=0;u<o.count;u++){let f=u/o.count*Math.PI*2,h=l.spectrum||l.bands?.spectrum,d=h?.[Math.floor(u/o.count*h.length)],v=.2+(d===void 0?Ut(l,u%2?"mid":"bass"):Math.min(1,d>1?d/255:d))*1.2;a.position.set(Math.cos(f)*5,-3+v/2,Math.sin(f)*5),a.scale.set(1,v,1),a.rotation.y=-f,a.updateMatrix(),o.setMatrixAt(u,a.matrix)}o.instanceMatrix.needsUpdate=!0}},params(l){t.visible=!!l.discRing},quality(l){o.count=ti(l)<.5?32:64},stats:()=>({triangles:o.count*12,drawCalls:t.visible?1:0})})}function A3(i){let e=i.THREE,t=xn(i),n=Ke(i,new e.TorusGeometry(1,.018,4,64)),r=Ke(i,new e.MeshBasicMaterial({color:9424346,transparent:!0,opacity:.4,depthWrite:!1})),s=Ke(i,new e.InstancedMesh(n,r,6)),o=new e.Object3D,a=new Float32Array(6).fill(-100);t.add(s);let l=0,c=!1,u=0,f=-100;return yn(t,i.params,i.quality,{update(h,d){let p=d.reduced?0:h.sceneTime??h.time??0,v=Ut(h,"bass"),g=typeof h.onset=="number"?h.onset>.3:!!h.onset;t.visible=(d.ripples??0)>0,(g&&!c||v>.6&&u<=.6)&&p-f>.25&&(a[l++%6]=p,f=p),c=g,u=v;for(let m=0;m<6;m++){let y=p-a[m],_=y>=0&&y<2.4;o.position.set(0,-2.9,0),o.rotation.x=-Math.PI/2,o.scale.setScalar(_?(.5+y*3)*(d.ripples??0):0),o.updateMatrix(),s.setMatrixAt(m,o.matrix)}s.instanceMatrix.needsUpdate=!0},stats:()=>({triangles:3072,drawCalls:t.visible?1:0})})}var x0={dust:w3,"spectrum-orbit":T3,ripple:A3};function _0(i,e=Object.keys(x0)){let t=e.map(n=>x0[n]?.(i)).filter(Boolean);return{update(n){t.forEach(r=>r.update(n))},resize(n,r){t.forEach(s=>s.resize(n,r))},setParams(n){t.forEach(r=>r.setParams(n))},setQuality(n){t.forEach(r=>r.setQuality(n))},dispose(){t.forEach(n=>n.dispose())},stats(){return t.map(n=>n.stats())}}}function M0(i,e){let t=_0(i),n=i.params;return{group:e.group,update(r){e.update(r),t.update(Cd(r,n.reduced))},resize(r,s){e.resize?.(r,s),t.resize(r,s)},setParams(r){n=r,e.setParams?.(r),t.setParams(r)},setQuality(r){e.setQuality?.(r),t.setQuality(r)},dispose(){t.dispose(),e.dispose()},...e.setRig?{setRig(r){e.setRig(r)}}:{},stats:()=>({primary:e.stats?.(),effects:t.stats()})}}function Sy(i){for(let[e,t]of Object.entries(x0))i.register({apiVersion:1,stateVersion:1,id:e,label:{dust:"\u7A7A\u95F4\u5149\u5C18","spectrum-orbit":"\u73AF\u7ED5\u9891\u8C31",ripple:"\u8282\u62CD\u6D9F\u6F2A"}[e],category:"\u7EC4\u5408\u6548\u679C",preview:"/space-scene-preview/aurora-dome.jpg",aliases:[],params:{},camera:{},capabilities:{effect:!0,stage:"geometry",depth:!0},quality:{},create:t});for(let[e,t]of Object.entries(uo))i.register({apiVersion:1,stateVersion:1,id:"post-"+e,label:t.label,category:"\u955C\u5934\u6548\u679C",preview:"/space-scene-preview/aurora-dome.jpg",aliases:[],params:{amount:t},camera:{},capabilities:{effect:!0,stage:"post",sharedChain:!0},quality:{},create(n){let r=n.params.amount??0;return{update(){},resize(){},setQuality(){},dispose(){},setParams(s){r=s.amount??r},contribution:()=>({key:e,uniform:"u"+e[0].toUpperCase()+e.slice(1),amount:r})}}})}var E3=`
uniform sampler2D uScene,uDepth;uniform vec2 uPixel;uniform float uTime,uNear,uFar,uFocus,uQuality;
uniform float uHalftone,uGrain,uVignette,uSoftness,uBokeh,uChroma,uAberration,uDistort,uBloom;
varying vec2 vUv;
float rnd(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
vec3 sampleColor(vec2 uv){return texture2D(uScene,clamp(uv,vec2(.001),vec2(.999))).rgb;}
void main(){
 vec2 radial=vUv-.5;float edge=dot(radial,radial);
 vec2 uv=vUv+radial*edge*uAberration*.0008;
 uv+=vec2(sin(uv.y*16.0+uTime*.2),cos(uv.x*13.0))*.00035*uDistort;
 vec3 c=sampleColor(uv);float chroma=uChroma+uAberration*.3;
 if(chroma>0.0){vec2 d=radial*uPixel*chroma*2.0;c.r=sampleColor(uv+d).r;c.b=sampleColor(uv-d).b;}
 float depth=texture2D(uDepth,uv).x;
 float distance=uNear*uFar/(uFar-depth*(uFar-uNear));
 float blur=uQuality>0.0?uSoftness*.15+uBokeh*.16*smoothstep(1.0,7.0,abs(distance-uFocus)):0.0;
 if(blur>0.0){vec2 d=uPixel*blur;vec3 soft=(sampleColor(uv+vec2(d.x,0.0))+sampleColor(uv-vec2(d.x,0.0))+sampleColor(uv+vec2(0.0,d.y))+sampleColor(uv-vec2(0.0,d.y)))*.25;c=mix(c,soft,min(.8,blur*.3));}
 if(uBloom>0.0)c+=max(c-.6,vec3(0.0))*uBloom*.08;
 if(uHalftone>0.0){float dotPattern=step(.26,length(fract(gl_FragCoord.xy/4.0)-.5));c*=mix(1.0,.55+.45*dotPattern,uHalftone*.025);}
 c+=(rnd(gl_FragCoord.xy+floor(uTime*24.0))-.5)*uGrain*.003;
 c*=1.0-smoothstep(.08,.5,edge)*uVignette*.01;
 gl_FragColor=vec4(c,1.0);
}`;function by(i){let e=i.THREE,t=new e.Scene,n=new e.OrthographicCamera(-1,1,1,-1,0,1),r={uScene:{value:null},uDepth:{value:null},uPixel:{value:new e.Vector2(1,1)},uTime:{value:0},uNear:{value:i.camera.near},uFar:{value:i.camera.far},uFocus:{value:12},uQuality:{value:1}};for(let m of Object.keys(uo))r["u"+m[0].toUpperCase()+m.slice(1)]={value:0};let s=Ke(i,new e.PlaneGeometry(2,2)),o=Ke(i,new e.ShaderMaterial({uniforms:r,depthTest:!1,depthWrite:!1,vertexShader:"varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}",fragmentShader:E3})),a=new e.Mesh(s,o);a.frustumCulled=!1,t.add(a);let l=null,c=1,u=1,f=!1,h=i.params||{},d=i.quality;function p(){return Object.keys(uo).some(m=>Number(h[m]||i.services.post?.[m])>0)}function v(m){h={...h,...m};for(let[y,_]of Object.entries(uo)){let x=Number(h[y]||i.services.post?.[y])||0;r["u"+y[0].toUpperCase()+y.slice(1)].value=Math.max(_.min,Math.min(_.max,x))}!p()&&l&&(l.dispose(),l=null)}function g(m,y){typeof m=="object"&&(y=m.height,m=m.width),c=Math.max(1,Math.floor((m||1)*.5)),u=Math.max(1,Math.floor((y||1)*.5)),l?.setSize(c,u),r.uPixel.value.set(1/c,1/u)}return v(h),{update(m){r.uTime.value=h.reduced?0:m.sceneTime??m.time??0},setParams:v,setQuality(m){d=m,r.uQuality.value=m.mode==="low"?0:1},resize:g,render(m,y,_){if(f)return;if(!p()){m.render(y,_);return}l||(l=new e.WebGLRenderTarget(c,u,{minFilter:e.LinearFilter,magFilter:e.LinearFilter}),l.depthTexture=new e.DepthTexture(c,u),l.depthTexture.type=e.UnsignedIntType),r.uScene.value=l.texture,r.uDepth.value=l.depthTexture,r.uNear.value=_.near,r.uFar.value=_.far,r.uFocus.value=Math.max(1,_.position.length()),r.uQuality.value=d?.mode==="low"?0:1;let x=m.getRenderTarget(),S=m.autoClear;try{m.autoClear=!0,m.setRenderTarget(l),m.render(y,_),m.setRenderTarget(x),m.render(t,n)}finally{m.setRenderTarget(x),m.autoClear=S}},stats(){return{active:p(),drawCalls:p()?1:0,bytes:l?c*u*8:0}},dispose(){f||(f=!0,l?.dispose(),l=null,a.removeFromParent())}}}var C3=[["reactor","\u7C92\u5B50\u53CD\u5E94\u5806","particles",My],["particle-silk","\u7C92\u5B50\u7EF8\u5E26","particles",i=>Br(i,"silk")],["gravity-sphere","\u5F15\u529B\u661F\u7403","particles",i=>Br(i,"sphere"),["immersive/orb","orb"]],["warp-tunnel","\u6298\u8DC3\u96A7\u9053","particles",i=>Br(i,"tunnel"),["immersive/tunnel"]],["prism-galaxy","\u68F1\u955C\u661F\u7CFB","particles",i=>Br(i,"galaxy"),["immersive/prism","prism"]],["cover-sphere","\u5C01\u9762\u661F\u7403","artwork",xy,["immersive/silk","silk"]],["cover-particles","\u7C92\u5B50\u5C01\u9762","artwork",yy],["spectrum-towers","\u9891\u8C31\u5854\u6797","spectrum",i=>uy(i),["creative/towers","towers"]],["spectrum-sphere","\u9891\u8C31\u7403","spectrum",i=>Br(i,"spectrum-sphere",[16755322,8707583]),["creative/orb"]],["light-tunnel","\u5149\u96A7\u9053","spectrum",i=>hy(i,!0),["creative/tunnel","tunnel"]],["spectrum-nebula","\u661F\u4E91","spectrum",i=>Br(i,"nebula",[7461362,15827641]),["creative/nebula","nebula"]],["spectrum-terrain","\u9891\u8C31\u5730\u5F62","spectrum",i=>Rd(i),["creative/terrain","terrain"]],["lyric-corridor","\u4E09\u7EF4\u6B4C\u8BCD","lyrics",i=>lo(i),["creative/lyric","lyric","stage"]],["word-wipe","\u9010\u5B57\u64E6\u9664","lyrics",i=>lo(i,"wipe"),["space-layers/karaoke"]],["lyric-classic","\u6D41\u5149","lyrics",i=>lo(i,"classic"),["classic"]],["lyric-cadenza","\u5FC3\u8C61","lyrics",i=>lo(i,"cadenza"),["cadenza"]],["lyric-sonnet","\u5546\u7C41","lyrics",i=>lo(i,"sonnet"),["sonnet"]],["lyric-tempera","\u51DD\u5F69","lyrics",i=>lo(i,"tempera"),["tempera"]],["handdrawn-manga","\u6F2B\u753B\u6750\u8D28","material",i=>Nu(i,"manga"),["handdrawn/manga"]],["handdrawn-anime","\u8D5B\u7490\u7490\u6750\u8D28","material",i=>Nu(i,"anime"),["handdrawn/anime"]],["handdrawn-pencil","\u94C5\u7B14\u6750\u8D28","material",i=>Nu(i,"pencil"),["handdrawn/pencil"]],["handdrawn-color","\u53CC\u8272\u6750\u8D28","material",i=>Nu(i,"color"),["handdrawn/color"]],["background-mesh","\u7A7A\u95F4\u6E10\u53D8\u7F51\u683C","background",i=>Rd(i,"mesh"),["backgrounds/mesh","stanza/geometric"]],["background-flow","\u7A7A\u95F4\u6D41\u573A","background",i=>Br(i,"flow"),["backgrounds/flow","stanza/fluid"]],["background-spectrogram","\u7A7A\u95F4\u9891\u8C31\u8272\u8C31","background",i=>Rd(i,"spectrogram"),["backgrounds/spectrogram"]],["background-cover","\u5C01\u9762\u6C1B\u56F4","background",i=>Br(i,"cover"),["backgrounds/cover","stanza/atmosphere"]],["cover-wall","\u66F2\u9762\u5C01\u9762\u5899","artwork",my,["space-layers/bgwall","bgwall"]]];function R3([i,e,t,n,r=[]]){let s=t==="lyrics",o=i.includes("tunnel"),a=i.includes("galaxy"),l=i.includes("terrain")||i==="background-mesh"||i==="background-spectrogram",c=["classic","cadenza","sonnet","tempera"].find(d=>i==="lyric-"+d),u=(d,p=!0)=>({type:"boolean",label:d,default:p}),f=i.includes("sphere")||i==="background-cover",h=i==="spectrum-towers";return{apiVersion:1,id:i,stateVersion:1,label:e,category:{particles:"\u661F\u7A7A",artwork:"\u5C01\u9762\u827A\u672F",spectrum:"\u9891\u8C31",lyrics:"\u6B4C\u8BCD",material:"\u6750\u8D28",background:"\u7A7A\u95F4\u80CC\u666F"}[t],aliases:r,preview:"/space-scene-preview/"+i+".jpg",params:{...Za,...uo,reduced:{type:"boolean",label:"\u51CF\u5C11\u52A8\u6001",default:!1},...t==="particles"||i==="cover-particles"?{pointSize:_t("\u7C92\u5B50\u5927\u5C0F",1,.6,1.8),pointerStrength:_t("\u60AC\u505C\u51F9\u9677",1,0,2)}:{},...i==="cover-particles"?{relief:_t("\u5C01\u9762\u8D77\u4F0F",1,0,2.5)}:{},...i==="reactor"?{trackRecipes:u("\u6309\u66F2\u6362\u573A"),queuePreview:u("\u60AC\u505C\u9884\u89C8")}:{},...s?{textWidth:_t("\u6587\u5B57\u5BBD\u5EA6",12,6,18,.5),spacing:_t("\u884C\u8DDD",2.1,1.4,4,.1),arc:_t("\u6B4C\u8BCD\u5F27\u5EA6",.7,0,3,.1),karaoke:{type:"boolean",label:"\u9010\u5B57\u9AD8\u4EAE",default:!0},layout:cs("\u821E\u53F0\u4E3B\u9898","venue",["venue","diorama","tempo","still"])}:{},...c?{scale:_t("\u6B4C\u8BCD\u5B57\u53F7",1,.5,2),reactivity:_t("\u5F8B\u52A8\u5F3A\u5EA6",1.35,0,2),speed:_t("\u955C\u5934\u52A8\u6001",.65,0,2)}:{},...i==="lyric-classic"?{rotation:u("\u8BCD\u8BED\u65CB\u8F6C"),breathing:_t("\u547C\u5438\u5E45\u5EA6",1,0,2),wordSpacing:_t("\u8BCD\u8BED\u95F4\u8DDD",.7,0,2)}:{},...i==="lyric-cadenza"?{width:_t("\u6392\u7248\u5BBD\u5EA6",.72,.5,.9,.01),motion:_t("\u8FD0\u52A8\u5E45\u5EA6",1,0,2),glow:_t("\u8F89\u5149\u5F3A\u5EA6",1,0,1.6),beam:_t("\u5149\u675F\u5F3A\u5EA6",0,0,1.2)}:{},...i==="lyric-tempera"?{colorMode:cs("\u5957\u8272\u98CE\u683C","duo",["duo","mono","vivid"]),composition:cs("\u8272\u5757\u6784\u56FE","auto",["auto","split-duo","quad-grid","diagonal-cut","triptych","banded","poster-frame","fan-burst","shutters","offset-collage"]),screens:u("\u7F51\u5C4F\u7EB9\u7406"),inversion:u("\u626B\u5149\u53CD\u8272"),seams:u("\u5370\u5237\u63A5\u7F1D"),halation:_t("\u5149\u6655\u5F3A\u5EA6",.5,0,1)}:{},...i==="lyric-sonnet"?{shotFlow:cs("\u955C\u5934\u7F16\u6392","auto",["auto","editorial-column","type-impact","fragment-collage","tracking-ribbon","mask-reveal","poster-blocks","quiet-tableau"]),sceneKind:cs("\u7A7A\u95F4\u8C31\u9762","orbital",["orbital","constellation","perspective","wave-score","orrery","editorial-lattice"]),lyricLayout:cs("\u6B4C\u8BCD\u6392\u7248","phrases",[{value:"phrases",label:"\u77ED\u53E5"},{value:"lines",label:"\u6574\u884C"},{value:"staircase",label:"\u9636\u68AF"},{value:"editorial-track",label:"\u6587\u5B57\u8F68\u9053"}]),phraseLength:_t("\u77ED\u53E5\u957F\u5EA6",12,4,24,1),decor:u("\u753B\u9762\u88C5\u9970"),accents:u("\u5F3A\u8C03\u7279\u6548"),atmosphere:u("\u6C1B\u56F4\u5149"),halation:_t("\u5149\u6655\u5F3A\u5EA6",.5,0,1)}:{},...i==="cover-wall"?{radius:_t("\u66F2\u9762\u534A\u5F84",11,7,18,.5),coverIndex:_t("\u5F53\u524D\u5C01\u9762",0,0,1e5,1)}:{}},camera:i==="reactor"?{theta:0,phi:.06,radius:15,fov:48,lookAt:[0,0,0],minRadius:3,maxRadius:36,orbit:!0,zoom:!0,fit:{halfWidth:6.2,halfHeight:5.4}}:{theta:a||h?.3:0,phi:i==="cover-particles"?0:l||h||a?.35:.06,radius:o?5:s?15:a?21:l?22:f?9.2:i==="cover-wall"?8:i==="cover-particles"?9.6:13,lookAt:l?[0,-1,-2]:o?[0,0,-4]:[0,0,0],fov:i==="cover-particles"?54:58,minRadius:3,maxRadius:36,orbit:!0,zoom:!0},capabilities:{interaction:!0,threejs:!0,depth:!0,lyrics:s,ownsLyrics:s,...c?{stanzaRenderer:c}:{},...i==="reactor"?{queuePreview:!0}:{},effects:!0,director:!0,cues:!0,cover:i.includes("cover")},quality:i==="cover-particles"?{low:{particles:9216,drawCalls:16},medium:{particles:20736,drawCalls:20},high:{particles:36864,drawCalls:24}}:{low:{particles:4e3,drawCalls:16},medium:{particles:7e3,drawCalls:20},high:{particles:1e4,drawCalls:24}},create(d){let p=n(d),v=_0(d,d.layer==="lyrics"?[]:void 0),g=d.params;return{update(m){let y=Cd(m,g.reduced,s),_=y.sceneTime;p.update(y),v.update(y),p.group&&!s&&(p.group.rotation.z=g.director?Math.sin(_*.08)*.04:0,p.group.scale.setScalar((g.scale??1)*(g.cue==="chorus"?1.08:1)),p.group.rotation.x=g.cue==="bridge"?.06:0)},resize(m,y){p.resize(m,y),v.resize(m,y)},setParams(m){g=m,p.setParams(m),v.setParams(m)},setQuality(m){p.setQuality(m),v.setQuality(m)},...p.setRig?{setRig(m){p.setRig(m)}}:{},dispose(){v.dispose(),p.dispose()},stats:()=>({primary:p.stats?.(),effects:v.stats()})}}}}var P3=C3.map(R3);function wy(i){P3.forEach(e=>i.register(e))}var gi=km(),Ty=km(),Ay={interaction:!0,ownsLyrics:!1,effects:!0,threejs:!0};gi.register({apiVersion:1,id:"coast",stateVersion:1,label:"\u6D77\u5CB8\u516C\u8DEF",category:"world",preview:"/space-scene-preview/coast.jpg",aliases:[],params:{...y0,tod:{type:"number",label:"\u65F6\u6BB5",default:0,min:0,max:1,step:.01},reduced:{type:"boolean",label:"\u51CF\u5C11\u52A8\u6001",default:!1}},camera:{theta:-1.071,phi:.346,radius:5.33,fov:44,lookAt:[0,1.05,.9],minRadius:2.4,maxRadius:15},capabilities:Ay,quality:{pooled:!0},create:i=>M0(i,Ux(i))});gi.register({apiVersion:1,id:"zodiac",stateVersion:1,label:"\u661F\u5EA7",category:"world",preview:"/space-scene-preview/zodiac.jpg",aliases:[],params:{...y0,sign:{type:"select",label:"\u661F\u5EA7",default:"cycle",options:[{value:"cycle",label:"\u5FAA\u73AF"},...Ad.ZODIAC.map(i=>({value:i.id,label:i.cn}))]},field:{type:"boolean",label:"\u661F\u5C18",default:!0},glow:{type:"number",label:"\u8F89\u5149",default:1,min:0,max:2,step:.05},speed:{type:"number",label:"\u8FD0\u52A8",default:1,min:.15,max:3,step:.05},reduced:{type:"boolean",label:"\u51CF\u5C11\u52A8\u6001",default:!1}},camera:{theta:0,phi:.06,radius:11.87,fov:52,lookAt:[0,0,0],minRadius:2.6,maxRadius:30,fit:{halfWidth:Ad.FIG_HALF_W*1.3,halfHeight:Ad.FIG_HALF*1.3}},capabilities:Ay,quality:{pooled:!0},create:i=>M0(i,sy(i))});wy(gi);Sy(Ty);var I3=()=>gi.catalog(),L3=()=>Ty.catalog(),D3=i=>gi.register(i),N3=i=>gi.resolve(i)||null,F3=(i,e)=>gi.normalizeState(i,e);function U3(i){if(!i)return null;if(typeof i!="object")throw new Error("Invalid camera pose");let e=i.lookAt||[i.tx||0,i.ty||0,i.tz||0],t=i.world||{},n={yaw:i.theta===void 0?i.yaw||0:i.theta+(t.y||t.cy||0),pitch:i.phi===void 0?i.pitch||0:i.phi+(t.x||t.cx||0),dist:i.radius===void 0?i.dist||8:i.radius,fov:i.fov||52,tx:e[0],ty:e[1],tz:e[2],roll:i.roll||0,external:!0};if(i.position!==void 0){if(!Array.isArray(i.position)||i.position.length!==3||!i.position.every(Number.isFinite))throw new Error("Invalid free camera position");n.position=i.position.slice()}if(!Object.values(n).filter(r=>typeof r=="number").every(Number.isFinite))throw new Error("Invalid camera pose values");return n}function B3(i,e={}){if(!i||typeof i.addEventListener!="function")throw new Error("Stage requires a canvas");let t=mx(e.qualityMode,e.deviceTier),n=nd(),r=Ei(fi,e.onInvalidate,L=>d.resolveCover?d.resolveCover(L):L);n.defer(()=>r.dispose());let s;try{s=new Lr({canvas:i,antialias:!1,powerPreference:"high-performance"})}catch(L){throw n.dispose(),new Error(`WebGL initialization failed: ${L.message}`)}s.info.autoReset=!1;let o=null,a=null,l=0,c=0,u=!1,f=640,h=360,d={spatialResources:r},p=null,v="idle",g="",m=!1,y=0,_=null,x=[],S=0,b=null;function E(){let L=s.info,U=x.slice().sort((ne,ie)=>ne-ie),X=U.length?U[Math.floor(U.length/2)]:null,te=o?o.scope.stats():{resources:0,tasks:0,estimatedBytes:0},Z=a?a.scope.stats():{resources:0,tasks:0,estimatedBytes:0},K=r.stats(),j=o&&o.post&&o.post.stats?o.post.stats():{bytes:0};return{state:v,id:o&&o.def.id,lyricId:a&&a.def.id,error:g,...t.status(),frameCount:y,actualFps:X?1e3/X:null,frameIntervalP95:U.length?U[Math.floor(U.length*.95)]:null,cpuUpdateRenderMs:S,gpuMs:b,gpuTimingSource:"unavailable",drawCalls:L.render.calls,points:L.render.points,triangles:L.render.triangles,geometries:L.memory.geometries,textures:L.memory.textures,programs:L.programs?L.programs.length:0,physicalPixels:i.width*i.height,memorySource:"tracked-resource-estimate",...te,resources:te.resources+Z.resources,estimatedBytes:te.estimatedBytes+Z.estimatedBytes+K.bytes+j.bytes,textTextures:K.textTextures,coverTextures:K.coverTextures,tasks:te.tasks+Z.tasks+K.queued,sceneStats:o?.instance?.stats?.()||null}}function M(){typeof e.onStatus=="function"&&e.onStatus(E())}function T(){let L=o;o=null,L&&(L.scope.trackTree(L.scene),L.scope.dispose(),L.scene.clear(),s.renderLists.dispose(),s.info.reset())}function A(){let L=a;a=null,L&&(L.scope.trackTree(L.scene),L.scope.dispose(),L.scene.clear(),s.renderLists.dispose())}async function I(L,U={}){if(u)throw new Error("Stage disposed");if(m)throw new Error("WebGL context is lost; recreate the stage to retry");let X=L?gi.normalizeState(L,U):null,te=X&&gi.get(X.id);if(te&&!te.capabilities.ownsLyrics)throw new Error("Expected a lyric effect");let Z=++c;if(A(),!te)return M(),null;let K=nd(),j=new li,ne=new Ft(te.camera.fov||58,f/h,.05,900);ne.position.set(0,0,te.camera.radius||15),ne.lookAt(0,0,0);let ie={THREE:fi,scene:j,camera:ne,renderer:s,scope:K,layer:"lyrics",params:X.params,quality:t.profile(),signal:K.signal,services:d},We={def:te,scene:j,camera:ne,scope:K,context:ie,params:X.params,instance:null};a=We;try{let Fe=await te.create(ie);if(!Fe||typeof Fe.update!="function"||typeof Fe.dispose!="function")throw new Error("Invalid lyric instance");return u||Z!==c||K.signal.aborted?(Fe.dispose(),K.trackTree(j),K.dispose(),null):(We.instance=Fe,K.defer(()=>Fe.dispose()),K.trackTree(j),Fe.setParams?.(We.params),Fe.setQuality?.(t.profile()),Fe.resize?.(f,h),t.warmup(null),M(),X)}catch(Fe){throw K.trackTree(j),K.dispose(),a===We&&(a=null,M()),Fe}}function D(L,U){u||(f=Math.max(2,Math.floor(Number(L)||2)),h=Math.max(2,Math.floor(Number(U)||2)),s.setPixelRatio(t.dpr(f,h,globalThis.devicePixelRatio||1)),s.setSize(f,h,!1),t.warmup(null),o&&(o.camera.aspect=f/h,o.camera.updateProjectionMatrix(),o.instance&&o.instance.resize&&o.instance.resize(f,h),o.post&&o.post.resize(f,h)),a&&(a.camera.aspect=f/h,a.camera.updateProjectionMatrix(),a.instance?.resize?.(f,h)))}function B(){D(f,h),o&&o.instance&&o.instance.setQuality&&o.instance.setQuality(t.profile()),o&&o.post&&o.post.setQuality(t.profile()),a?.instance?.setQuality?.(t.profile()),M()}function F(L){g=L instanceof Error?L.message:String(L),v="failed",l++,c++,T(),A(),M()}return n.listen(i,"webglcontextlost",L=>{L.preventDefault(),m=!0,F("WebGL context lost")}),n.listen(i,"webglcontextrestored",()=>{m=!1,t.warmup(null),v="idle",M()}),D(i.clientWidth||640,i.clientHeight||360),{selectLyrics:I,async select(L,U={}){if(u)throw new Error("Stage disposed");if(m)throw new Error("WebGL context is lost; recreate the stage to retry");let X=gi.normalizeState(L,U),te=gi.get(X.id),Z=++l;T(),s.setRenderTarget(null),s.setClearColor(197637,1),s.outputColorSpace=nn,s.toneMapping=Mn,s.toneMappingExposure=1,s.shadowMap.enabled=!1;let K=nd(),j=new li,ne=new Ft(52,f/h,.05,900);j.background=new be(197637);let ie=te.camera;if(ie.position)ne.position.fromArray(ie.position);else{let Ye=Math.cos(ie.phi||0),$=ie.radius||8;ne.position.set(Math.sin(ie.theta||0)*Ye*$,Math.sin(ie.phi||0)*$,Math.cos(ie.theta||0)*Ye*$)}ne.lookAt(...ie.lookAt||[0,0,0]),ne.fov=ie.fov||52,ne.updateProjectionMatrix();let We={THREE:fi,scene:j,camera:ne,renderer:s,scope:K,params:X.params,quality:t.profile(),signal:K.signal,services:d};o={def:te,scene:j,camera:ne,scope:K,params:X.params,context:We,instance:null,post:null};let Fe=o;v="loading",g="",M();try{let Ye=await te.create(We);if(!Ye||typeof Ye.update!="function"||typeof Ye.dispose!="function")throw new Error("Invalid scene instance");return u||Z!==l||K.signal.aborted?(Ye.dispose(),K.trackTree(j),K.dispose(),null):(Fe.instance=Ye,K.defer(()=>Ye.dispose()),K.trackTree(j),Fe.post=by(We),Fe.post&&K.defer(()=>Fe.post.dispose()),Ye.setParams&&Ye.setParams(Fe.params),Ye.setRig&&Ye.setRig(p),B(),v="ready",_=null,x=[],t.warmup(null),M(),X)}catch(Ye){throw K.trackTree(j),K.dispose(),Z===l&&!u&&(o=null,F(Ye)),Ye}},frame(L={}){if(u||v!=="ready"||!o||typeof document<"u"&&document.hidden)return!1;let U=Number.isFinite(L.now)?L.now:performance.now();_!==null&&U-_>500&&(x=[],_=null,t.warmup(null));let X=Number.isFinite(L.dt)?Math.max(0,Math.min(L.dt,.25)):_===null?.016:Math.min((U-_)/1e3,.25);_!==null&&U>_&&(x.push(U-_),x.length>240&&x.shift()),_=U;let te=performance.now();try{if(L.deviceTier!==void 0&&t.setDeviceTier(L.deviceTier)&&B(),r.beginFrame(U),o.instance.update({...L,now:U,dt:X}),a?.instance&&(a.scene.visible=!!L.lyrics?.lines?.length&&!o.def.capabilities.ownsLyrics,a.instance.update({...L,now:U,dt:X})),o.post&&o.post.update&&o.post.update(L),s.info.reset(),o.post?o.post.render(s,o.scene,o.camera):s.render(o.scene,o.camera),a?.instance&&a.scene.visible){let Z=s.autoClear,K=s.toneMapping,j=s.toneMappingExposure;try{s.setRenderTarget(null),s.autoClear=!1,s.toneMapping=Mn,s.toneMappingExposure=1,s.clearDepth(),s.render(a.scene,a.camera)}finally{s.autoClear=Z,s.toneMapping=K,s.toneMappingExposure=j}}return S=performance.now()-te,y++,t.sample(U,()=>{let Z=s.info.render,K=o.scope.stats(),j=r.stats(),ne=o.post&&o.post.stats?o.post.stats().bytes:0;return{drawCalls:Z.calls,points:Z.points,triangles:Z.triangles,estimatedBytes:K.estimatedBytes+(a?a.scope.stats().estimatedBytes:0)+j.bytes+ne}},S)&&B(),y%120===0&&M(),!0}catch(Z){return F(Z),!1}},resize:D,setQualityMode(L){u||(t.setMode(L),B())},setDeviceTier(L){!u&&t.setDeviceTier(L)&&B()},effectiveQuality(){return t.profile().mode},setLyricParams(L){if(!a?.instance)return null;let U=gi.validateParams(a.def.id,L,a.params);return a.params=U,a.context.params=U,a.instance.setParams?.(U),{id:a.def.id,stateVersion:a.def.stateVersion,params:U}},setParams(L){if(!o||!o.instance)return null;let U=gi.validateParams(o.def.id,L,o.params);o.params=U,o.context.params=U;try{o.instance.setParams&&o.instance.setParams(U),o.post&&o.post.setParams(U)}catch(X){throw F(X),X}return{id:o.def.id,stateVersion:o.def.stateVersion,params:U}},setRig(L){if(p=U3(L),!(!o||!o.instance)){if(p&&!p.position&&o.def.camera.fit){let U=o.def.camera.fit,X=Math.tan(p.fov*Math.PI/360),te=Math.max(U.halfHeight/X,U.halfWidth/(X*f/h));p.dist*=Math.max(1,te/o.def.camera.radius)}if(o.instance.setRig)o.instance.setRig(p);else if(p){let U=o.camera;if(p.position)U.position.fromArray(p.position),U.rotation.set(p.pitch,p.yaw,p.roll,"YXZ");else{let X=Math.cos(p.pitch);U.position.set(p.tx+Math.sin(p.yaw)*X*p.dist,p.ty+Math.sin(p.pitch)*p.dist,p.tz+Math.cos(p.yaw)*X*p.dist),U.lookAt(p.tx,p.ty,p.tz),U.rotateZ(p.roll)}U.fov=p.fov,U.updateProjectionMatrix()}}},setServices(L={}){Object.keys(d).filter(U=>U!=="spatialResources").forEach(U=>delete d[U]),Object.assign(d,L,{spatialResources:r})},dispose(){u||(u=!0,l++,c++,T(),A(),n.dispose(),s.dispose(),s.forceContextLoss(),v="disposed",M())},stats:E}}return Ly(O3);})();
