Pod::Spec.new do |s|
  s.name           = 'ICloudFiles'
  s.version        = '0.1.0'
  s.summary        = 'Native iOS iCloud Drive folder bookmarking and coordinated .excalidraw file access for Excalidesk'
  s.description    = 'Allows Excalidesk iOS to bookmark iCloud Drive folders, check ubiquitous download status, and read .excalidraw files with NSFileCoordinator.'
  s.author         = 'Excalidesk'
  s.homepage       = 'https://excalidesk.linjiejim.com'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files   = '**/*.{h,m,mm,swift}'
end
