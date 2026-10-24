import React,{useId} from 'react';

// Original illustrations for sections and empty covers, never catalog records.
export default function Artwork({kind='manga',hero=false,className=''}){
  const id=useId().replaceAll(':','');
  const colors={manga:['#ec6e46','#f2b27e','#21202a'],video:['#8e81ce','#d3baf5','#26213d'],audio:['#438ca1','#a8d4cd','#142e3a'],book:['#7c906a','#d3ce9a','#29352e'],image:['#af7898','#edc5bd','#392c42']};
  const [a,b,c]=colors[kind]||colors.manga;
  return <svg className={className} viewBox={hero?'0 0 640 430':'0 0 300 390'} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><linearGradient id={id+'sky'} x2="0" y2="1"><stop stopColor={c}/><stop offset="1" stopColor={a}/></linearGradient><linearGradient id={id+'sun'} x2="0" y2="1"><stop stopColor={b}/><stop offset="1" stopColor={a}/></linearGradient></defs>
    {hero?<>
      <rect width="640" height="430" fill="#222124"/><path d="M80 0h560v430H0z" fill={'url(#'+id+'sky)'}/>
      <circle cx="424" cy="163" r="123" fill={'url(#'+id+'sun)'}/>
      <path d="m270 31 26 10M341 9l12 26m139-7-10 25M568 62l-26 16M595 142l-30 4M253 95l29 13" stroke={b} strokeWidth="2" opacity=".35"/>
      <g fill="#25242f"><path d="M154 292V185h33v107h13V160h38v132h10V204h48v88h11V142h29v150h12V194h30v98h12V224h48v68h13V174h23v118h12V137h26v155h17V190h47v102h17V164h33v128h28v138H154z"/></g>
      <g fill={b} opacity=".35">{[210,260,316,359,462,507,564].map((x,i)=><g key={x}><rect x={x} y={220-i*4} width="4" height="8"/><rect x={x+9} y={240-i*4} width="4" height="8"/><rect x={x} y={262-i*4} width="4" height="8"/></g>)}</g>
      <path d="m154 331 486-29v128H30z" fill="#17191f"/><path d="m148 331 492-29" stroke={b} strokeWidth="2" opacity=".4"/><path d="M202 314v-44l438-27M268 266v65m79-70v66m80-73v67m78-72v68m76-72v66" fill="none" stroke="#17191f" strokeWidth="5"/>
      <path d="M390 181c-12-43 4-73 30-76 34-3 55 27 42 68l-9 22-49 3z" fill="#151820"/><path d="M409 150c-4 25 1 43 16 45 15 2 27-12 26-35l-21-19-5 17-4-12z" fill="#edb595"/>
      <path d="m410 189-23 21-19 96 54 18 55-22-17-95-19-17-12 19z" fill="#343c4a"/><path d="m405 203-12 93 30 16 12-108-7 17z" fill="#9a6958"/><path d="m394 211-17 86m66-92 24 84" fill="none" stroke="#c29b83" strokeWidth="3"/>
      <path d="m392 304 4 91 18 1 16-82 4 84h20l3-94z" fill="#151820"/><path d="m395 390-12 15h34v-14m19 1-3 14h33l-14-15" fill="#111319"/>
      <path d="M0 0h189L93 430H0z" fill="#202022"/><path d="M166 0 70 430M182 0 86 430" stroke="#d9c6af" strokeWidth="2" opacity=".12"/>
      <path d="m534 0-8 97 114-31V0zm17 15h70v35l-75 20z" fill="#17191f" opacity=".75"/><path d="M104 38h69M90 102h66M76 166h66" stroke="#d9c6af" strokeWidth="2" opacity=".12"/>
      <path d="m291 430 349-26v26z" fill="#101217"/>
    </>:<>
      <rect width="300" height="390" fill={'url(#'+id+'sky)'}/><circle cx="173" cy="116" r="85" fill={'url(#'+id+'sun)'}/>
      {kind==='audio'?<><circle cx="150" cy="208" r="100" fill="#132531"/><circle cx="150" cy="208" r="76" fill="none" stroke={b} opacity=".24"/><circle cx="150" cy="208" r="55" fill="none" stroke={b} opacity=".15"/><circle cx="150" cy="208" r="25" fill={a}/><circle cx="150" cy="208" r="6" fill={b}/><path d="M253 80v137l-28 42" stroke={b} strokeWidth="7" fill="none"/><path d="m30 326 28-14 21 18 22-12 22 10 27-17 26 20 29-13 22 8 45-14" stroke={b} strokeWidth="2" fill="none"/></>:<>
        <path d="m0 257 74-124 67 96 52-65 107 112v114H0z" fill={c}/><path d="m0 306 99-104 104 125 54-57 43 42v78H0z" fill="#171b23"/>
        {kind==='manga'||kind==='video'?<><g fill="#171b23"><path d="M32 302V182h24v120h12V217h31v85h10V158h22v144h14V200h30v102h10V246h44v56h9V187h23v115h39v88H0v-88z"/></g><path d="m122 282 8-77 15-17 18 7 9 90-17 34 3 47h-11l-9-54-5 54h-12l4-52z" fill="#0f151d"/><ellipse cx="146" cy="181" rx="15" ry="20" fill="#0f151d"/><path d="M0 322h300M18 322v68m68-68v68m68-68v68m68-68v68m68-68v68" stroke={a} strokeWidth="1.5" opacity=".35"/></>:<><path d="m89 202 50 12 50-12v103l-50 13-50-13z" fill={b}/><path d="m139 214 2 105m-39-98 25 7m-25 8 25 7m-25 8 25 7m25-30 25-7m-25 22 25-7m-25 22 25-7" fill="none" stroke={c} strokeWidth="2"/><path d="M50 390c8-74 4-119-21-164m235 164c-11-64-4-137 22-185" fill="none" stroke={b} strokeWidth="2"/><path d="M39 274c-26-5-34-18-30-38 23 3 35 16 30 38m9 36c23-9 32-23 25-44-22 9-31 23-25 44m222-43c-26-8-32-23-23-43 25 9 31 23 23 43" fill={a}/></>}
      </>}
      <path d="M14 15h272v360H14z" fill="none" stroke={b} strokeWidth="1" opacity=".2"/>
      <path d="M30 35h43m-43 8h28" stroke={b} strokeWidth="2" opacity=".5"/>
    </>}
  </svg>;
}
