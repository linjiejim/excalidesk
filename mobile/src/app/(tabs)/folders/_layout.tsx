import { Stack } from 'expo-router';

import { t } from '@/lib/i18n';

export default function FoldersLayout() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitleEnabled: true,
        headerTransparent: true,
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      <Stack.Screen name="index" options={{ title: t.folders }} />
      <Stack.Screen name="browse" />
    </Stack>
  );
}
