// Speech shapes for the head, layered over the contact solver exactly the way
// `FaceImpactRig` is (src/impact-rig.js): a separate additive offset applied
// after the spring integration, never fed into it.
//
// It must NOT drive `FaceDynamics.rig.jaw`. That is a pose control, and
// `NewtonFaceDynamics.step` (src/newton-dynamics.js) treats any change to `rig`
// as a new pose: it bumps a version, zeroes the accumulated offsets and
// re-uploads to the physics server. At 60 fps that would thrash the solver.
//
// Heads arrive watertight — `build_photo_face.py` rejects anything else — so the
// lips start as a sealed surface. `src/mouth-aperture.js` cuts the sealing band
// away at load; this rig then drives three things into the hole it leaves: the
// jaw swinging on a hinge, the lip rim parting, and the corners spreading or
// gathering. On a head whose mouth could not be located nothing is cut, and the
// same shapes simply read as stretching lips.
//
// Shapes are precomputed once per anchor set as three basis fields, because a
// speaking mouth needs a new pose every frame and impact fields do not. `step`
// is then one multiply-add pass, not a field rebuild.
//
// A head whose lips were given their own seam (src/lip-topology.js) is rigged
// from that seam instead of from anchors: see `_buildFromLips`. Which lip a
// vertex belongs to is then a fact of the mesh rather than a guess from its
// height, which is what lets the two lips move apart without tearing anything.

import {lipField} from './lip-topology.js';

const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const smooth=(a,b,v)=>{const t=clamp((v-a)/(b-a),0,1);return t*t*(3-2*t);};

// Same reference-frame table as FaceImpactRig, so a head that never had anchors
// detected still gets a plausible mouth instead of nothing.
const DEFAULT_ANCHORS={
  13:[0,-.04,.07],14:[0,-.042,.07],152:[0,-.105,.045],
  50:[-.05,-.005,.06],280:[.05,-.005,.06],
  61:[-.03,-.04,.065],291:[.03,-.04,.065],
};

// Peak travel per shape, in metres on a head normalised to ~0.2 m hairline-to-chin.
// The jaw limit is deliberately under what the manual Jaw slider allows: sealed
// lips stretch rather than part, and past this the lower face reads as rubber.
const OPEN_LIMIT=.0145,SPREAD_LIMIT=.0060,ROUND_LIMIT=.0050;
// Share of the jaw's travel spent parting the lip rim rather than swinging the
// whole lower face. Once src/mouth-aperture.js has removed the sealing band this
// is what actually opens the hole; on a still-sealed head it just reads as the
// lips stretching, which is what they did before.
const LIP_PART=.055;
// Shapes chase the signal with a short constant so an abrupt analyser reading
// cannot snap a vertex. The signal is already smoothed; this is a safety net.
const FOLLOW_SECONDS=.025;
// On a cut mouth the opening is sized as FaceFusion / LivePortrait size it: the
// inner-lip gap as a fraction of this head's own mouth width, so a small mouth
// and a large one open to the same shape. 0.30 is a full spoken "ah".
const OPEN_RATIO=.30;
// The jaw swing may carry the chin further than the lips; never past this.
const OPEN_LIMIT_CUT=.024;
// Lip travel on top of the jaw swing, as a share of the jaw's travel at the
// lips: the upper lip lifts a little, the lower lip drops a little further.
const UPPER_LIFT=.16,LOWER_DROP=.10;

/** Scale a basis field so its largest vertex displacement is exactly `limit`. */
function normalize(field,limit){
  let maximum=0;
  for(let i=0;i<field.length;i+=3){
    const m=Math.hypot(field[i],field[i+1],field[i+2]);
    if(m>maximum)maximum=m;
  }
  if(maximum>1e-9){const k=limit/maximum;for(let i=0;i<field.length;i++)field[i]*=k;}
  return field;
}

export class FaceSpeechRig{
  constructor(rest,anchors){
    this.rest=rest;
    this.offset=new Float32Array(rest.length);
    this.open=0;this.spread=0;this.round=0;
    this._want={open:0,spread:0,round:0};
    this._written=false;
    this.setAnchors(anchors);
  }

  setAnchors(anchors){this.anchors=anchors??DEFAULT_ANCHORS;this._build();}

  /**
   * The lip seam cut by src/lip-topology.js, or null for a head without one.
   * A topology that does not describe this vertex buffer is ignored.
   */
  setLipTopology(topology){this.lipTopology=topology??null;this._build();}

  /** Target shape, each 0..1. Called once per frame from the render loop. */
  set(signal){
    const s=signal||{};
    this._want.open=clamp(Number(s.open)||0,0,1);
    this._want.spread=clamp(Number(s.spread)||0,0,1);
    this._want.round=clamp(Number(s.round)||0,0,1);
  }

  /**
   * `duck` scales the whole rig down, so a landed punch reads over the top of a
   * sentence instead of fighting it.
   */
  step(dt,duck=1,gasp=0){
    const k=1-Math.exp(-Math.max(dt,0)/FOLLOW_SECONDS);
    this.open+=(this._want.open-this.open)*k;
    this.spread+=(this._want.spread-this.spread)*k;
    this.round+=(this._want.round-this.round)*k;
    const scale=clamp(duck,0,1);
    // `gasp` is the pain rig's parted mouth (src/pain-rig.js): a floor under the
    // jaw, never added to a voice that is already opening it further.
    const open=Math.max(this.open,clamp(gasp,0,1))*scale,spread=this.spread*scale,round=this.round*scale;
    // How far the jaw is open right now, after ducking: what `offset` was built from.
    this.openNow=open;
    // A silent face must be bit-for-bit untouched, and must not pay for a full
    // buffer write on every frame it stays silent.
    if(!this.openBasis||(open<1e-4&&spread<1e-4&&round<1e-4)){
      if(this._written){this.offset.fill(0);this._written=false;}
      return;
    }
    for(let i=0;i<this.offset.length;i++){
      this.offset[i]=open*this.openBasis[i]+spread*this.spreadBasis[i]+round*this.roundBasis[i];
    }
    this._written=true;
  }

  reset(){
    this.openNow=0;
    this.open=this.spread=this.round=0;
    this._want.open=this._want.spread=this._want.round=0;
    this.offset.fill(0);this._written=false;
  }

  _build(){
    const rest=this.rest,a=this.anchors;
    const upper=a[13],lower=a[14],chin=a[152];
    // Without a mouth line there is no defensible place to put a mouth. Go inert
    // rather than deform the middle of someone's face on a guess.
    // `jaw` is only known for a mouth with a seam: see _buildFromLips.
    this.jaw=null;
    if(!upper||!lower||!chin){this.openBasis=this.spreadBasis=this.roundBasis=null;this.lips=null;return;}
    this.lips=this.lipTopology?lipField(rest,this.lipTopology):null;
    if(this.lips)return this._buildFromLips(chin);
    const mouth=upper.map((v,i)=>(v+lower[i])*.5),mx=mouth[0],my=mouth[1],mz=mouth[2];
    // Same normalisation the impact rig uses, so both rigs agree on head size.
    const scale=clamp((my-chin[1])/.058,.65,1.5);
    const cornerL=a[61]??[mx-.030*scale,my,mz],cornerR=a[291]??[mx+.030*scale,my,mz];
    const open=new Float32Array(rest.length);
    const spread=new Float32Array(rest.length);
    const round=new Float32Array(rest.length);
    const gaussian=(x,y,c,rx,ry)=>Math.exp(-(((x-c[0])/(rx*scale))**2)-(((y-c[1])/(ry*scale))**2));
    // Hinge placement lifted from the tuned hook field in src/impact-rig.js.
    const hy=my+.064*scale,hz=mz-.085*scale;
    for(let i=0;i<rest.length;i+=3){
      const x=rest[i],y=rest[i+1],z=rest[i+2];
      // Speech moves the lower front of the face only: never the skull, never
      // the neck, never above the nose. Blend out rather than cut, or the jaw
      // tears at the mask border.
      const front=smooth(mz-.14*scale,mz-.035*scale,z);
      const neck=smooth(chin[1]-.045*scale,chin[1]-.008*scale,y);
      // Fade out by the base of the nose. A wider band reaches eye level on a
      // real head (anchors 159/386 sit around y+.037), and lips that spread must
      // not stir an eyelid — however faintly.
      const underNose=1-smooth(my+.030*scale,my+.055*scale,y);
      const mask=front*neck*underNose;
      if(mask<1e-5)continue;

      const mouthWeight=gaussian(x,y,mouth,.053,.030);
      const lowerFace=1-smooth(my-.015*scale,my+.035*scale,y);
      const jaw=lowerFace*Math.exp(-(((x-mx)/(.115*scale))**4));
      const lowerLip=smooth(my+.003*scale,my-.013*scale,y);
      const jawWeight=(jaw*(1-mouthWeight)+mouthWeight*lowerLip)*mask;
      // Linearised hinge rotation. For small angles dy≈-(z-hz)θ and dz≈(y-hy)θ,
      // which is linear in θ — so `open` scales this basis directly instead of
      // the rig having to re-derive a rotation every frame.
      open[i+1]=-(z-hz)*jawWeight;
      open[i+2]=(y-hy)*jawWeight;
      // Explicit rim separation: upper lip up, lower lip down, in a tight band
      // along the lip line. The hinge above drags both lips the same way, so
      // without this the aperture barely changes shape.
      const lipBand=Math.exp(-(((x-mx)/(.034*scale))**2)-(((y-my)/(.011*scale))**2))*mask;
      open[i+1]+=(y>my?1:-1)*lipBand*LIP_PART;

      const corners=(gaussian(x,y,cornerL,.030,.026)+gaussian(x,y,cornerR,.030,.026))*mask;
      // No `||1` fallback here, unlike the directional hook field in impact-rig.js:
      // spreading and rounding are symmetric, so a vertex exactly on the midline
      // must get no lateral motion at all rather than an arbitrary sideways nudge.
      const side=Math.sign(x-mx);
      // Wide vowels: corners travel outward, lips flatten toward the mouth line.
      spread[i]=side*corners;
      spread[i+1]=-(y-my)*mouthWeight*mask*.55;
      // Rounded vowels: corners gather in, lips purse forward and bunch.
      round[i]=-side*corners*.85;
      round[i+1]=(y-my)*mouthWeight*mask*.35;
      round[i+2]=mouthWeight*mask;
    }
    this.openBasis=normalize(open,OPEN_LIMIT);
    this.spreadBasis=normalize(spread,SPREAD_LIMIT);
    this.roundBasis=normalize(round,ROUND_LIMIT);
  }

  /**
   * The same three shapes on a mouth that has a real seam.
   *
   * The jaw weight `u` is 0 on the skull and 1 on the mandible. Mid-mouth it is
   * a step across the seam — the upper lip stays with the skull, the lower lip
   * goes with the jaw, and the cut is what lets that happen. Towards the corners
   * the step closes to 0.5 on both sides, so the corners travel half as far and
   * stay joined; beyond them it feathers out smoothly, the way FaceFusion
   * feathers every mask it pastes back. The field is therefore discontinuous
   * exactly where the mesh is, and nowhere else.
   */
  _buildFromLips(chin){
    const rest=this.rest,lips=this.lips;
    const [mx,my,mz]=lips.centre;
    const scale=clamp((my-chin[1])/.058,.65,1.5);
    const [cornerL,cornerR]=lips.corners;
    const open=new Float32Array(rest.length);
    const spread=new Float32Array(rest.length);
    const round=new Float32Array(rest.length);
    const gaussian=(x,y,c,rx,ry)=>Math.exp(-(((x-c[0])/(rx*scale))**2)-(((y-c[1])/(ry*scale))**2));
    const hy=my+.064*scale,hz=mz-.085*scale;
    // Jaw travel at the lips per unit of hinge angle, to size the lip terms by.
    const lipArm=mz-hz;
    for(let i=0,v=0;i<rest.length;i+=3,v++){
      const x=rest[i],y=rest[i+1],z=rest[i+2];
      const front=smooth(mz-.14*scale,mz-.035*scale,z);
      const neck=smooth(chin[1]-.045*scale,chin[1]-.008*scale,y);
      const underNose=1-smooth(my+.030*scale,my+.055*scale,y);
      const mask=front*neck*underNose;
      if(mask<1e-5)continue;

      const side=lips.side[v],height=lips.height[v],taper=lips.taper[v];
      // Metres past a corner. The feather widens out over the cheek, where skin
      // stretches between cheekbone and jaw over a much longer run than a lip.
      const beyond=Math.max(0,-lips.along[v],lips.along[v]-1)*lips.width;
      const feather=(.016+.014*smooth(0,.035*scale,beyond))*scale;
      const hard=taper+(1-taper)*smooth(0,feather,Math.abs(height));
      const u=.5-.5*side*hard;
      const jawWeight=u*Math.exp(-(((x-mx)/(.115*scale))**4))*mask;
      open[i+1]=-(z-hz)*jawWeight;
      open[i+2]=(y-hy)*jawWeight;
      // The lips themselves: a tight band along the seam, zero at the corners.
      const band=taper*Math.exp(-((height/(.010*scale))**2))*mask*lipArm;
      if(side>0)open[i+1]+=band*UPPER_LIFT;
      else if(side<0)open[i+1]-=band*LOWER_DROP;

      const mouthWeight=gaussian(x,y,lips.centre,.053,.030);
      const corners=(gaussian(x,y,cornerL,.030,.026)+gaussian(x,y,cornerR,.030,.026))*mask;
      const lateral=Math.sign(x-mx);
      // Flatten towards, or bunch away from, the seam itself rather than a level
      // line: a lip line is curved, and both copies of a seam vertex must agree.
      spread[i]=lateral*corners;
      spread[i+1]=-height*mouthWeight*mask*.55;
      round[i]=-lateral*corners*.85;
      round[i+1]=height*mouthWeight*mask*.35;
      round[i+2]=mouthWeight*mask;
    }
    // Size the opening off this mouth: gap over width, measured mid-seam.
    const [top,bottom]=this._lipCentres();
    const gap=open[top*3+1]-open[bottom*3+1];
    if(!(gap>1e-9)){this.openBasis=this.spreadBasis=this.roundBasis=null;return;}
    let k=OPEN_RATIO*lips.width/gap,furthest=0;
    for(let i=0;i<open.length;i+=3)furthest=Math.max(furthest,Math.hypot(open[i],open[i+1],open[i+2]));
    k=Math.min(k,OPEN_LIMIT_CUT*scale/furthest);
    for(let i=0;i<open.length;i++)open[i]*=k;
    this.openBasis=open;
    // The open shape is a hinge swing of `k` radians per unit of `open`, about a
    // horizontal axis through (hingeY, hingeZ). Anything rigid that belongs to the
    // jaw (src/mouth-interior.js: the lower teeth, the tongue) swings on the same
    // hinge by the same angle, so it keeps its place behind the lower lip.
    this.jaw={hingeY:hy,hingeZ:hz,angle:k,lipArm};
    this.spreadBasis=normalize(spread,SPREAD_LIMIT);
    this.roundBasis=normalize(round,ROUND_LIMIT);
  }

  /** The upper-lip and lower-lip vertices at the middle of the seam. */
  _lipCentres(){
    const lips=this.lips;
    // An adopted mouth labels the whole lip, not just its edge, so "middle" has
    // to mean mid-mouth AND on the seam.
    const off=(v)=>Math.abs(lips.along[v]-.5)+2*Math.abs(lips.height[v])/lips.width;
    const middle=(list)=>list.reduce((best,v)=>off(v)<off(best)?v:best,list[0]);
    return [middle(this.lipTopology.upper),middle(this.lipTopology.lower)];
  }

  /** Inner-lip gap over mouth width right now: FaceFusion's lip-open ratio. */
  get lipOpenRatio(){
    if(!this.lips||!this.openBasis)return 0;
    const [top,bottom]=this._lipCentres();
    return (this.offset[top*3+1]-this.offset[bottom*3+1])/this.lips.width;
  }
}
