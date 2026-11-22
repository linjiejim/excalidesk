import { NativeTabs } from 'expo-router/native-tabs';

import { t } from '@/lib/i18n';
import { accent } from '@/lib/theme';

export default function TabsLayout() {
  return (
    <NativeTabs tintColor={accent} minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="(recents)">
        <NativeTabs.Trigger.Label>{t.recents}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="clock" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="folders">
        <NativeTabs.Trigger.Label>{t.folders}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'folder', selected: 'folder.fill' }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Label>{t.search}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
