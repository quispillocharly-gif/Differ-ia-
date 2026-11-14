package com.aimtraining.pool

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 40, 28, 24)
            setBackgroundColor(0xFFF4F7FB.toInt())
        }
        root.addView(TextView(this).apply {
            text = "AIM TRAINING • 8 BALL POOL"
            textSize = 22f
            setTextColor(0xFF12345A.toInt())
        })
        root.addView(TextView(this).apply {
            text = "Asistente visual de práctica. No apunta ni dispara por ti. Activa la superposición para ver la guía sobre el juego."
            textSize = 16f
            setPadding(0, 18, 0, 24)
        })
        root.addView(Button(this).apply {
            text = "1. Permitir superposición"
            setOnClickListener {
                if (!Settings.canDrawOverlays(this@MainActivity)) {
                    startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
                } else startOverlay()
            }
        })
        root.addView(Button(this).apply {
            text = "2. Iniciar guía flotante"
            setOnClickListener {
                if (Settings.canDrawOverlays(this@MainActivity)) startOverlay()
                else startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            }
        })
        root.addView(TextView(this).apply {
            text = "Controles flotantes: arrastra el panel, ajusta el ángulo y la longitud de la línea de práctica. La detección automática de bolas y rebotes todavía requiere validación en el Galaxy A14."
            textSize = 13f
            setPadding(0, 22, 0, 0)
        })
        setContentView(root)
    }

    private fun startOverlay() {
        startService(Intent(this, AimOverlayService::class.java))
        finish()
    }
}
