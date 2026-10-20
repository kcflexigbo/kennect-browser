import {writeFile} from 'node:fs/promises';import gifenc from 'gifenc';import pngjs from 'pngjs';
export async function encodeGif(frames,path){
 if(!Array.isArray(frames)||!frames.length)throw Error('No recording frames.');if(frames.length>60)throw Error('Recording exceeds 60 frames.');
 const gif=gifenc.GIFEncoder();let dimensions;
 for(const frame of frames){
  const bytes=Buffer.from(frame.png,'base64');if(bytes.length<24||bytes.length>4*1024*1024||bytes.subarray(1,4).toString()!=='PNG')throw Error('Invalid recording frame.');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);if(width<1||height<1||width*height>8e6)throw Error('Recording frame is too large.');
  if(dimensions&&(dimensions[0]!==width||dimensions[1]!==height))throw Error('Window size changed during recording. Record again without resizing.');dimensions=[width,height];
  const {data}=pngjs.PNG.sync.read(bytes);const palette=gifenc.quantize(data,256);const indexed=gifenc.applyPalette(data,palette);
  gif.writeFrame(indexed,width,height,{palette,delay:Math.max(20,Math.min(frame.duration||700,5000)),repeat:0});
 }
 gif.finish();await writeFile(path,gif.bytes());
}
