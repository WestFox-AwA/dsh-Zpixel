import {createScene} from './scene.mjs';

export function topDownAssetScene(id='zpixel03-topdown-assets'){
  const groundPixels=Array(96*96).fill('ground0');
  for(let y=0;y<96;y++)for(let x=0;x<96;x++)if((x+y)%8===0)groundPixels[y*96+x]='ground1';
  return createScene({id,title:'Top-down environment asset assembly',width:96,height:96,camera:{preset:'top_down',target:[0,2,0],pixelsPerUnit:3.2},
    palette:{ground0:'#40534a',ground1:'#4b6253',wall0:'#6f7070',wall1:'#a6a49a',gate0:'#754c35',gate1:'#b47a4c',leaf0:'#315b3e',leaf1:'#638448',rock0:'#56606a',rock1:'#93999b',ink:'#1d2927'},
    ramps:{wall:{stops:[{at:0,color:'wall0'},{at:.8,color:'wall1'}]},gate:{stops:[{at:0,color:'gate0'},{at:.8,color:'gate1'}]},leaf:{stops:[{at:0,color:'leaf0'},{at:.8,color:'leaf1'}]},rock:{stops:[{at:0,color:'rock0'},{at:.8,color:'rock1'}]}},
    materials:{wall:{ramp:'wall'},gate:{ramp:'gate'},leaf:{ramp:'leaf'},rock:{ramp:'rock'}},
    nodes:[
      {id:'ground',name:'Painted ground',role:'terrain-surface',kind:'layer',width:96,height:96,pixelSize:.4,plane:'xz',pixels:groundPixels,transform:{position:[-19.2,0,19.2]},anchors:{tree_root:{point:[27.2,0,-19.2],normal:[0,1,0],tangent:[1,0,0]},rock_root:{point:[32.2,0,-19.2],normal:[0,1,0],tangent:[1,0,0]}}},
      {id:'wall-left',name:'Stone wall (left)',role:'wall',kind:'part',material:'wall',geometry:{type:'extrude',points:[[-3,-0.8],[3,-0.8],[3,0.8],[-3,0.8]],range:[0,3],axis:'y'},transform:{position:[-7,0,0]},anchors:{hinge:{point:[3,1.5,0],normal:[-1,0,0],tangent:[0,1,0],axis:[0,1,0]}}},
      {id:'wall-right',name:'Stone wall (right)',role:'wall',kind:'part',material:'wall',geometry:{type:'extrude',points:[[-3,-0.8],[3,-0.8],[3,0.8],[-3,0.8]],range:[0,3],axis:'y'},transform:{position:[7,0,0]}},
      {id:'gate',name:'Hinged gate',role:'gate',kind:'part',material:'gate',geometry:{type:'box',min:[-4,0,-0.8],max:[2,3.4,0.8]},transform:{position:[0,0,0]},anchors:{hinge:{point:[-4,1.5,0],normal:[-1,0,0],tangent:[0,1,0],axis:[0,1,0]}}},
      {id:'trunk',name:'Tree trunk',role:'tree-trunk',kind:'part',geometry:{type:'cylinder',center:[0,1,0],radius:.5,length:2,axis:'y'},transform:{position:[8,0,0]},anchors:{root:{point:[0,0,0],normal:[0,-1,0]},crown:{point:[0,2,0],normal:[0,1,0],tangent:[1,0,0]}}},
      {id:'canopy',name:'Tree canopy',role:'canopy',kind:'part',material:'leaf',geometry:{type:'ellipsoid',center:[0,0,0],radii:[2,1.3,2]},transform:{position:[8,3,0]},anchors:{base:{point:[0,-1.3,0],normal:[0,-1,0],tangent:[1,0,0]}}},
      {id:'rock',name:'Mossy rock',role:'rock',kind:'part',material:'rock',geometry:{type:'ellipsoid',center:[0,1,0],radii:[2,1,1.5]},transform:{position:[13,0,0]},anchors:{ground:{point:[0,0,0],normal:[0,-1,0]}}},
      {id:'arrow',name:'Northwest direction marker',role:'direction-marker',kind:'part',semanticFrame:{forward:[0,0,-1],up:[0,1,0]},geometry:{type:'extrude',points:[[-.22,0],[.22,0],[.22,-2.2],[.7,-2.2],[0,-3.2],[-.7,-2.2],[-.22,-2.2]],range:[0,.18],axis:'y'},transform:{position:[13,0,7]},anchors:{base:{point:[0,0,0],normal:[0,-1,0]}}}
    ],
    spatialRelations:[
      {id:'gate-hinge',from:{node:'gate',anchor:'hinge'},relation:'coaxial',to:{node:'wall-left',anchor:'hinge'},angleTolerance:2,distanceTolerance:.03},
      {id:'gate-wall-contact',from:{node:'gate',anchor:'hinge'},relation:'contact',to:{node:'wall-left',anchor:'hinge'},tolerance:.03},
      {id:'tree-ground-support',from:{node:'trunk',anchor:'root'},relation:'support',to:{node:'ground',anchor:'tree_root'},tolerance:.03},
      {id:'canopy-trunk-overlap',from:{node:'canopy',anchor:'base'},relation:'allow_overlap',to:{node:'trunk',anchor:'crown'}},
      {id:'rock-ground-support',from:{node:'rock',anchor:'ground'},relation:'support',to:{node:'ground',anchor:'rock_root'},tolerance:.03}
    ]
  });
}

export function bridgeScene(id='zpixel03-bridge-stress'){
  return createScene({id,width:64,height:64,camera:{preset:'three_quarter',target:[0,2,0],pixelsPerUnit:4},nodes:[
    {id:'lower',kind:'part',material:'wood',geometry:{type:'box',min:[-.5,0,-.5],max:[.5,2,.5]}},
    {id:'bridge',kind:'part',geometry:{type:'box',min:[-.5,6,-3],max:[.5,7,3]}}
  ]});
}
