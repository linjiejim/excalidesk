import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { init } from '@/lib/store';

void SplashScreen.preventAutoHideAsync();
init();

export default function RootLayout() {
  const scheme = useColorScheme();
  useEffect(() => {
    SplashScreen.hide();
  }, []);

  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="viewer" options={{ headerTransparent: true, title: '' }} />
        <Stack.Screen
          name="notes"
          options={{
            presentation: 'formSheet',
            sheetAllowedDetents: [0.45, 1],
            sheetGrabberVisible: true,
            headerShown: false,
          }}
        />
      </Stack>
    </ThemeProvider>
  );
}
