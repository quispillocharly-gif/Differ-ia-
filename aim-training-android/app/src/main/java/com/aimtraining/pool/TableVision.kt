package com.aimtraining.pool
import android.graphics.Bitmap
import android.media.Image
import kotlin.math.max
import kotlin.math.min
internal object TableVision{
 data class Ball(val x:Float,val y:Float,val radius:Float,val cue:Boolean)
 data class Bounds(val left:Float,val top:Float,val right:Float,val bottom:Float)
 data class Result(val tableFound:Boolean,val table:Bounds,val balls:List<Ball>,val cueBall:Ball?,val message:String){
  companion object{fun empty()=Result(false,Bounds(0f,0f,0f,0f),emptyList(),null,"esperando pantalla")}
 }
 fun analyze(image:Image):Result{
  val plane=image.planes[0];val buffer=plane.buffer;val stride=plane.pixelStride;val row=plane.rowStride
  val w=image.width;val h=image.height;val padded=w+(row-stride*w)/stride
  val bmp=Bitmap.createBitmap(padded,h,Bitmap.Config.ARGB_8888);buffer.rewind();bmp.copyPixelsFromBuffer(buffer)
  val step=max(2,min(w,h)/420);var minX=w;var minY=h;var maxX=0;var maxY=0;var green=0
  for(y in 0 until h step step)for(x in 0 until w step step){
   val p=bmp.getPixel(x,y);val r=p shr 16 and 255;val g=p shr 8 and 255;val b=p and 255
   if(g>r*1.14&&g>b*1.06&&g>45&&g-r>16){green++;minX=min(minX,x);minY=min(minY,y);maxX=max(maxX,x);maxY=max(maxY,y)}
  }
  if(green<(w/step)*(h/step)*.02||maxX-minX<w*.30||maxY-minY<h*.14){bmp.recycle();return Result.empty()}
  val ix=((maxX-minX)*.035f).toInt();val iy=((maxY-minY)*.04f).toInt()
  val l=(minX+ix).coerceAtLeast(0);val r=(maxX-ix).coerceAtMost(w-1);val t=(minY+iy).coerceAtLeast(0);val bot=(maxY-iy).coerceAtMost(h-1)
  val gw=(r-l)/step+1;val gh=(bot-t)/step+1;val mask=BooleanArray(gw*gh);val seen=BooleanArray(mask.size)
  for(gy in 0 until gh)for(gx in 0 until gw){
   val p=bmp.getPixel((l+gx*step).coerceAtMost(w-1),(t+gy*step).coerceAtMost(h-1));val rr=p shr 16 and 255;val gg=p shr 8 and 255;val bb=p and 255;val lum=(rr+gg+bb)/3
   val felt=gg>rr*1.12&&gg>bb*1.04&&gg>42&&gg-rr>13
   mask[gy*gw+gx]=!felt&&lum>105&&(max(rr,max(gg,bb))-min(rr,min(gg,bb))>20||lum>210)
  }
  val queue=IntArray(mask.size);val balls=ArrayList<Ball>()
  for(start in mask.indices){
   if(!mask[start]||seen[start])continue
   var head=0;var tail=0;queue[tail++]=start;seen[start]=true
   var x0=gw;var y0=gh;var x1=0;var y1=0;var count=0;var sx=0L;var sy=0L;var white=0
   while(head<tail){
    val idx=queue[head++];val gx=idx%gw;val gy=idx/gw;count++;sx+=gx;sy+=gy;x0=min(x0,gx);x1=max(x1,gx);y0=min(y0,gy);y1=max(y1,gy)
    val col=bmp.getPixel((l+gx*step).coerceAtMost(w-1),(t+gy*step).coerceAtMost(h-1))
    if((col shr 16 and 255)>185&&(col shr 8 and 255)>185&&(col and 255)>175)white++
    for(ny in max(0,gy-1)..min(gh-1,gy+1))for(nx in max(0,gx-1)..min(gw-1,gx+1)){val ni=ny*gw+nx;if(mask[ni]&&!seen[ni]){seen[ni]=true;queue[tail++]=ni}}
   }
   val cw=x1-x0+1;val ch=y1-y0+1;val ratio=cw.toFloat()/ch.coerceAtLeast(1)
   if(count in 5..260&&ratio in .62f..1.48f&&cw in 3..28&&ch in 3..28)balls.add(Ball(l+sx.toFloat()/count*step,t+sy.toFloat()/count*step,(cw+ch)*step/4f,white.toFloat()/count>.42f))
  }
  bmp.recycle();val cue=balls.filter{it.cue}.maxByOrNull{it.radius};val selected=balls.sortedByDescending{it.radius}.take(16)
  return Result(true,Bounds(l.toFloat(),t.toFloat(),r.toFloat(),bot.toFloat()),selected,cue,if(selected.isEmpty())"mesa visible; buscando bolas" else "detección heurística")
 }
}