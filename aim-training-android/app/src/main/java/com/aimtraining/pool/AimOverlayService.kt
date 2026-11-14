package com.aimtraining.pool

import android.app.Service
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.PointF
import android.os.IBinder
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
    private lateinit var wm: WindowManager
    private var panel: LinearLayout? = null
    private var guide: AimGuideView? = null
    private var angle = -25f
    private var length = 520f
    private var visibleGuide = true

    override fun onCreate() {
        super.onCreate()
        wm = getSystemService(WINDOW_SERVICE) as WindowManager
        showOverlay()
    }

    private fun showOverlay() {
        val type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply { gravity = Gravity.TOP or Gravity.START; x = 24; y = 150 }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(14, 10, 14, 10)
            setBackgroundColor(0xEE10243A.toInt())
        }
        val title = TextView(this).apply { text = "AIM • PRÁCTICA"; setTextColor(Color.WHITE); textSize = 14f }
        box.addView(title)
        box.addView(Button(this).apply {
            text = "Ángulo −"
            setOnClickListener { angle -= 2f; guide?.invalidate() }
        })
        box.addView(Button(this).apply {
            text = "Ángulo +"
            setOnClickListener { angle += 2f; guide?.invalidate() }
        })
        box.addView(Button(this).apply {
            text = "Línea: mostrar/ocultar"
            setOnClickListener { visibleGuide = !visibleGuide; guide?.visibility = if (visibleGuide) View.VISIBLE else View.INVISIBLE }
        })
        box.addView(Button(this).apply {
            text = "Cerrar guía"
            setOnClickListener { stopSelf() }
        })
        box.setOnTouchListener(object : View.OnTouchListener {
            var sx = 0f; var sy = 0f; var ox = 0; var oy = 0
            override fun onTouch(v: View, e: MotionEvent): Boolean {
                if (e.action == MotionEvent.ACTION_DOWN) { sx=e.rawX; sy=e.rawY; ox=params.x; oy=params.y; return true }
                if (e.action == MotionEvent.ACTION_MOVE) { params.x=ox+(e.rawX-sx).toInt(); params.y=oy+(e.rawY-sy).toInt(); wm.updateViewLayout(box,params); return true }
                return false
            }
        })
        panel = box
        wm.addView(box, params)

        val gp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        )
        guide = AimGuideView()
        wm.addView(guide, gp)
    }

    inner class AimGuideView : View(this@AimOverlayService) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color=0xCC35E6FF.toInt(); strokeWidth=4f; style=Paint.Style.STROKE }
        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            if (!visibleGuide) return
            val cx = width * .5f
            val cy = height * .70f
            val radians = Math.toRadians(angle.toDouble())
            val ex = cx + cos(radians).toFloat() * length
            val ey = cy + sin(radians).toFloat() * length
            canvas.drawLine(cx, cy, ex, ey, paint)
            paint.style=Paint.Style.FILL
            canvas.drawCircle(cx, cy, 8f, paint)
            paint.style=Paint.Style.STROKE
            canvas.drawCircle(ex, ey, 12f, paint)
        }
    }

    override fun onDestroy() {
        panel?.let { runCatching { wm.removeView(it) } }
        guide?.let { runCatching { wm.removeView(it) } }
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
}
