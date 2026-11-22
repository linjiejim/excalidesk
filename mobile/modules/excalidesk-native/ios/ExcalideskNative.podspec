Pod::Spec.new do |s|
  s.name           = 'ExcalideskNative'
  s.version        = '1.0.0'
  s.summary        = 'Excalidesk iOS viewer: folder access, offline Excalidraw rendering, PDFKit canvas'
  s.description    = 'Security-scoped folder bookmarks, an offline Excalidraw renderer in a hidden WKWebView that produces vector PDFs, and a PDFKit canvas view.'
  s.author         = 'Jim Lin'
  s.homepage       = 'https://excalidesk.linjiejim.com'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'PDFKit', 'WebKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "*.{h,m,mm,swift}"
  # Built by `npm run build:renderer` (Excalidraw bundle + fonts). A folder reference keeps its directory layout.
  s.resource_bundles = { 'ExcalideskRenderer' => ['renderer'] }
end
