plugins {
 id("com.android.application")
 id("org.jetbrains.kotlin.android")
}
android {
 namespace="com.aimtraining.pool"
 compileSdk=35
 defaultConfig { applicationId="com.aimtraining.pool"; minSdk=26; targetSdk=33; versionCode=2; versionName="2.0.0" }
 compileOptions { sourceCompatibility=JavaVersion.VERSION_17; targetCompatibility=JavaVersion.VERSION_17 }
 kotlinOptions { jvmTarget="17" }
}