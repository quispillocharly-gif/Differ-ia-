package com.aimtraining.pool

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.DisplayMetrics
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.cos
import kotlin.math.sin

class AimOverlayService : Service() {
    companion object { const val EXTRA_RESULT_CODE="projection_result_code"; const val EXTRA_RESULT_DATA="projection_result_data"; private const val CHANNEL="aim_training_capture"; private const val NOTIFICATION_ID=811 }
    private lateinit var wm:WindowManager
    private var panel:LinearLayout?=null
    private var overlay:AimDrawingView?=null
    private var projection:MediaProjection?=null
    private var reader:ImageReader?=null
    private var virtualDisplay:VirtualDisplay?=null
    private var worker:HandlerThread?=null
    private var workerHandler:Handler?=null
    private var screenW=0; private var screenH=0
    private var angleOffset=0f; private var showPath=true; private var showBalls=true
    @Volatile private var latest=TableVision.Result.empty()
    private var statusText:TextView?=null
    private var lastAnalysis=0L

    override fun onCreate() {
        super.onCreate()
        wm=getSystemService(WINDOW_SERVICE) as WindowManager
        val metrics=DisplayMetrics()
        @Suppress("DEPRECATION") wm.defaultDisplay.getRealMetrics(metrics)
        screenW=metrics.widthPixels; screenH=metrics.heightPixels
        createNotification()
        worker=HandlerThread("aim-screen-analysis").also { it.start() }
        workerHandler=Handler(worker!!.looper)
        createOverlay()
    }
    override fun onStartCommand(intent:Intent?,flags:Int,startId:Int):Int {
        val code=intent?.getIntExtra(EXTRA_RESULT_CODE,0) ?: 0
        @Suppress("DEPRECATION")
        val data=intent?.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
        if(code!=0 && data!=null && projection==null) startCapture(code,data)
        return START_NOT_STICKY
    }
    private fun createNotification() {
        val manager=getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if(Build.VERSION.SDK_INT>=26) manager.createNotificationChannel(NotificationChannel(CHANNEL,"Aim Training screen analysis",NotificationManager.IMPORTANCE_LOW))
        val notification=if(Build.VERSION.SDK_INT>=26) Notification.Builder(this,CHANNEL).setContentTitle("Aim Training activo").setContentText("Analizando pantalla y mesa").setSmallIcon(android.R.drawable.ic_menu_compass).build()
        else @Suppress("DEPRECATION") Notification.Builder(this).setContentTitle("Aim Training activo").setSmallIcon(android.R.drawable.ic_menu_compass).build()
        startForeground(NOTIFICATION_ID,notification)
    }
    private fun startCapture(code:Int,data:Intent) {
        try {
            val manager=getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            projection=manager.getMediaProjection(code,data)
            val density=resources.displayMetrics.densityDpi
            reader=ImageReader.newInstance(screenW,screenH,PixelFormat.RGBA_8888,2)
            reader?.setOnImageAvailableListener({ source ->
                val now=System.currentTimeMillis()
                if(now-lastAnalysis<300) source.acquireLatestImage()?.close()
                else {
                    lastAnalysis=now
                    val img=source.acquireLatestImage()
                    if(img!=null) workerHandler?.post {
                        try {
                            latest=TableVision.analyze(img)
                            this@AimOverlayService.overlay?.postInvalidate()
                            statusText?.post { statusText?.text=if(latest.tableFound) "Mesa · ${latest.balls.size} candidatos · ${latest.message}" else "Buscando mesa… ${latest.message}" }
                        } catch(_:Exception) { } finally { img.close() }
                    }
                }
            },workerHandler)
            virtualDisplay=projection?.createVirtualDisplay("AimTrainingDisplay",screenW,screenH,density,DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,reader?.surface,null,workerHandler)
            projection?.registerCallback(object:MediaProjection.Callback(){ override fun onStop(){ stopSelf() } },workerHandler)
        } catch(_:Exception) { statusText?.text="No se pudo iniciar la captura. Vuelve a autorizar."; stopSelf() }
    }
    private fun createOverlay() {
        val type=WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        val pp=WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT,WindowManager.LayoutParams.WRAP_CONTENT,type,WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,PixelFormat.TRANSLUCENT).apply { gravity=Gravity.TOP or Gravity.START; x=12; y=110 }
        val box=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; setPadding(12,8,12,8); setBackgroundColor(0xE91B2D43.toInt()) }
        box.addView(TextView(this).apply { text="AIM TRAINING • LIVE"; textSize=13f; setTextColor(Color.WHITE) })
        statusText=TextView(this).apply { text="Iniciando análisis…"; textSize=11f; setTextColor(0xFFB9E9FF.toInt()) }; box.addView(statusText)
        box.addView(Button(this).apply { text="Ángulo −"; setOnClickListener { angleOffset-=1f; this@AimOverlayService.overlay?.postInvalidate() } })
        box.addView(Button(this).apply { text="Ángulo +"; setOnClickListener { angleOffset+=1f; this@AimOverlayService.overlay?.postInvalidate() } })
        box.addView(Button(this).apply { text="Trayectoria ON/OFF"; setOnClickListener { showPath=!showPath; this@AimOverlayService.overlay?.postInvalidate() } })
        box.addView(Button(this).apply { text="Bolas ON/OFF"; setOnClickListener { showBalls=!showBalls; this@AimOverlayService.overlay?.postInvalidate() } })
        box.addView(Button(this).apply { text="Cerrar"; setOnClickListener { stopSelf() } })
        box.setOnTouchListener(object:View.OnTouchListener {
            var sx=0f; var sy=0f; var ox=0; var oy=0
            override fun onTouch(v:View,e:MotionEvent):Boolean {
                if(e.action==MotionEvent.ACTION_DOWN){sx=e.rawX;sy=e.rawY;ox=pp.x;oy=pp.y;return false}
                if(e.action==MotionEvent.ACTION_MOVE){pp.x=ox+(e.rawX-sx).toInt();pp.y=oy+(e.rawY-sy).toInt();runCatching{wm.updateViewLayout(box,pp)};return true}
                return false
            }
        })
        panel=box; wm.addView(box,pp)
        val dp=WindowManager.LayoutParams(WindowManager.LayoutParams.MATCH_PARENT,WindowManager.LayoutParams.MATCH_PARENT,type,WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,PixelFormat.TRANSLUCENT)
        overlay=AimDrawingView(); wm.addView(overlay,dp)
    }
    inner class AimDrawingView:View(this@AimOverlayService) {
        private val line=Paint(Paint.ANTI_ALIAS_FLAG).apply { color=0xDD27E8FF.toInt();strokeWidth=3.5f;style=Paint.Style.STROKE }
        private val ballPaint=Paint(Paint.ANTI_ALIAS_FLAG).apply { color=0xFFFFD54F.toInt();strokeWidth=3f;style=Paint.Style.STROKE }
        private val label=Paint(Paint.ANTI_ALIAS_FLAG).apply { color=Color.WHITE;textSize=25f }
        override fun onDraw(c:Canvas) {
            super.onDraw(c); val r=latest; if(!r.tableFound)return
            if(showBalls) r.balls.forEachIndexed { i,b -> c.drawCircle(b.x,b.y,b.radius,ballPaint); c.drawText(if(b.cue)"BLANCA" else "B${i+1}",b.x+10f,b.y-8f,label) }
            if(showPath) {
                val cue=r.cueBall ?: r.balls.firstOrNull() ?: return
                val target=r.balls.filter{it!=cue}.minByOrNull{(it.x-cue.x)*(it.x-cue.x)+(it.y-cue.y)*(it.y-cue.y)}
                val dx=if(target!=null)target.x-cue.x else (r.table.right-r.table.left)*.35f
                val dy=if(target!=null)target.y-cue.y else 0f
                val a=Math.toRadians(angleOffset.toDouble()); val vx=dx*cos(a).toFloat()-dy*sin(a).toFloat(); val vy=dx*sin(a).toFloat()+dy*cos(a).toFloat()
                val n=kotlin.math.sqrt(vx*vx+vy*vy).coerceAtLeast(1f); val reach=(r.table.right-r.table.left)*.72f
                c.drawLine(cue.x,cue.y,cue.x+vx/n*reach,cue.y+vy/n*reach,line); c.drawCircle(cue.x,cue.y,cue.radius+7f,line)
                if(target!=null){c.drawCircle(target.x,target.y,target.radius+8f,line);c.drawLine(target.x,target.y,target.x+vx/n*reach*.35f,target.y+vy/n*reach*.35f,ballPaint)}
            }
        }
    }
    override fun onDestroy() {
        runCatching{virtualDisplay?.release()};runCatching{reader?.close()};runCatching{projection?.stop()};worker?.quitSafely()
        panel?.let{runCatching{wm.removeView(it)}};overlay?.let{runCatching{wm.removeView(it)}}
        super.onDestroy()
    }
    override fun onBind(intent:Intent?):IBinder?=null
}