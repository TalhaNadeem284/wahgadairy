package com.wahgadairy.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SharedFilePlugin.class); // the picked Google Drive data file
        super.onCreate(savedInstanceState);
    }
}
