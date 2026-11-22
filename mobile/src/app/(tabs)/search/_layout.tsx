import { Stack } from 'expo-router';

import { t } from '@/lib/i18n';

export default function SearchLayout() {
  return (
    <Stack screenOptions={{ headerLargeTitleEnabled: true, headerTransparent: true, headerShadowVisible: false }}>
      <Stack.Screen name="index" options={{ title: t.search }} />
    </Stack>
  );
}
