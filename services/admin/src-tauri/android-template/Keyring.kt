package io.crates.keyring

import android.content.Context

/**
 * Bridge required by android-native-keyring-store before its Rust Store is
 * constructed. The native library contains the matching JNI export.
 */
class Keyring {
  companion object {
    init {
      System.loadLibrary("admin_lib")
    }

    external fun initializeNdkContext(context: Context)
  }
}
