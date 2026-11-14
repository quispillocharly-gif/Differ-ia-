package com.aimtraining.pool

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity() {
    private val captureRequest = 4102
    private lateinit var projectionManager: MediaProjectionManager
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        projectionManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val root = LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; gravity=Gravity.CENTER_HORIZONTAL; setPadding(28,36,28,28); setBackgroundColor(0xFFF1F6FC.toInt()) }
        root.addView(TextView(this).apply { text="AIM TRAINING FULL"; textSize=25f; setTextColor(0xFF12345A.toInt()) })
        root.addView(TextView(this).apply { text="Guía visual para practicar 8 Ball Pool. Analiza la pantalla autorizada, detecta candidatos de bolas y dibuja referencias de tiro. No toca ni dispara por ti."; textSize=16f; setTextColor(0xFF23364B.toInt()); setPadding(0,18,0,22) })
        root.addView(Button(this).apply { text="1 · Autorizar superposición"; setOnClickListener { if (!Settings.canDrawOverlays(this@MainActivity)) startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))) else status.text="Superposición autorizada." } })
        root.addView(Button(this).apply { text="2 · Iniciar reconocimiento"; setOnClickListener {
            if (!Settings.canDrawOverlays(this@MainActivity)) { startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))); status.text="Autoriza la superposición y vuelve." }
            else { status.text="Acepta la captura de pantalla de Android."; startActivityForResult(projectionManager.createScreenCaptureIntent(),captureRequest) }
        } })
        root.addView(Button(this).apply { text="Detener guía flotante"; setOnClickListener { stopService(Intent(this@MainActivity,AimOverlayService::class.java)); status.text="Guía detenida." } })
        val status=TextView(this).apply { text="Listo. Inicia aquí y luego abre 8 Ball Pool."; textSize=14f; setTextColor(0xFF34516D.toInt()); setPadding(0,20,0,0) }
        root.addView(status)
        root.addView(TextView(this).apply { text="Mantén el teléfono en la misma orientación. La precisión depende del contraste y requiere validación con partidas reales."; textSize=12f; setTextColor(0xFF53677C.toInt()); setPadding(0,24,0,0) })
        setContentView(root)
    }
    @Deprecated("Activity result API retained for compatibility")
    override fun onActivityResult(requestCode:Int,resultCode:Int,data:Intent?) {
        super.onActivityResult(requestCode,resultCode,data)
        if (requestCode==captureRequest && resultCode==RESULT_OK && data!=null) {
            val start=Intent(this,AimOverlayService::class.java).apply { putExtra(AimOverlayService.EXTRA_RESULT_CODE,resultCode); putExtra(AimOverlayService.EXTRA_RESULT_DATA,data) }
            startForegroundService(start); finish()
        }
    }
}