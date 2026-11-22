import ExpoModulesCore
import PDFKit
import UIKit

/// The canvas: PDFKit's native PDFView showing the vector render, with Photos-style gestures on top.
/// - pinch / pan / momentum / rubber-band: PDFView's own scroll view
/// - double tap: zoom in around the finger; double tap again: back to fit
/// - two-finger tap: zoom out a step
/// - single tap (after double-tap fails): toggle the chrome
final class DrawingView: ExpoView, UIGestureRecognizerDelegate {
  let onSingleTap = EventDispatcher()
  let onZoomChange = EventDispatcher()
  let onPageChange = EventDispatcher()
  let onReady = EventDispatcher()

  private let pdfView = PDFView()
  private var sourceURL: URL?
  private var paged = false
  private var pendingPage = 0
  private var lastBounds: CGSize = .zero
  private var wasAtFit = true
  private var lastReportedZoom: CGFloat = -1

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    pdfView.autoScales = true
    pdfView.displaysPageBreaks = false
    pdfView.pageShadowsEnabled = false
    pdfView.pageBreakMargins = .zero
    pdfView.displayMode = .singlePageContinuous
    pdfView.displayDirection = .vertical
    pdfView.backgroundColor = .clear
    pdfView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    pdfView.frame = bounds
    addSubview(pdfView)

    let double = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
    double.numberOfTapsRequired = 2
    double.delegate = self
    pdfView.addGestureRecognizer(double)

    let twoFinger = UITapGestureRecognizer(target: self, action: #selector(handleTwoFingerTap(_:)))
    twoFinger.numberOfTouchesRequired = 2
    twoFinger.delegate = self
    pdfView.addGestureRecognizer(twoFinger)

    let single = UITapGestureRecognizer(target: self, action: #selector(handleSingleTap(_:)))
    single.require(toFail: double)
    single.delegate = self
    pdfView.addGestureRecognizer(single)

    NotificationCenter.default.addObserver(self, selector: #selector(scaleChanged), name: .PDFViewScaleChanged, object: pdfView)
    NotificationCenter.default.addObserver(self, selector: #selector(pageChanged), name: .PDFViewPageChanged, object: pdfView)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  // MARK: Props

  func setSource(_ uri: String?) {
    guard let uri, let url = URL(string: uri) else { return }
    if url == sourceURL { return }
    sourceURL = url
    reload()
  }

  func setPaged(_ value: Bool) {
    if value == paged { return }
    paged = value
    applyMode()
  }

  func setCanvasColor(_ color: UIColor?) {
    let c = color ?? .systemBackground
    backgroundColor = c
    pdfView.backgroundColor = c
    pinInsets()
  }

  func setInitialPage(_ index: Int) {
    pendingPage = index
  }

  // MARK: Loading

  private func reload() {
    guard let url = sourceURL else { return }
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let doc = PDFDocument(url: url)
      DispatchQueue.main.async {
        guard let self, self.sourceURL == url, let doc else { return }
        self.pdfView.document = doc
        self.applyMode()
        if self.pendingPage > 0, let page = doc.page(at: min(self.pendingPage, doc.pageCount - 1)) {
          self.pdfView.go(to: page)
        }
        self.fit(animated: false)
        self.pinInsets()
        self.onReady(["pageCount": doc.pageCount])
      }
    }
  }

  private func applyMode() {
    guard pdfView.document != nil else { return }
    if paged {
      pdfView.displayMode = .singlePage
      pdfView.displayDirection = .horizontal
      pdfView.usePageViewController(true, withViewOptions: [UIPageViewController.OptionsKey.interPageSpacing: 24])
    } else {
      pdfView.usePageViewController(false, withViewOptions: nil)
      pdfView.displayMode = .singlePageContinuous
      pdfView.displayDirection = .vertical
    }
    pinInsets()
    fit(animated: false)
  }

  /// The canvas sits under the translucent bars and must not move when they hide (Photos-style):
  /// PDFView's inner scroll view would otherwise re-inset itself whenever the safe area changes.
  private func pinInsets() {
    let canvas = pdfView.backgroundColor ?? .systemBackground
    func walk(_ v: UIView) {
      if let s = v as? UIScrollView {
        s.contentInsetAdjustmentBehavior = .never
        s.automaticallyAdjustsScrollIndicatorInsets = false
      }
      // PDFKit paints each page white under its content; at the anti-aliased page edge that white shows as a
      // hairline on a dark canvas. Page views are created lazily, so this runs again on layout / zoom / page change.
      if NSStringFromClass(type(of: v)).contains("PDFPage") {
        v.backgroundColor = canvas
        v.layer.backgroundColor = canvas.cgColor
      }
      v.subviews.forEach(walk)
    }
    walk(pdfView)
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    pinInsets()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    pinInsets()
    pdfView.frame = bounds
    if bounds.size != lastBounds {
      lastBounds = bounds.size
      // Rotation / split view: stay fitted if the user was looking at the whole thing
      if wasAtFit { fit(animated: false) } else { updateLimits() }
    }
  }

  // MARK: Zoom

  private var fitScale: CGFloat {
    let s = pdfView.scaleFactorForSizeToFit
    return s > 0 ? s : 1
  }

  private func updateLimits() {
    let base = fitScale
    pdfView.minScaleFactor = base
    // Up to 4× real size, and never less than 12× the fitted view, so huge canvases still zoom in to readable text
    pdfView.maxScaleFactor = max(4, base * 12)
  }

  func fit(animated: Bool) {
    guard pdfView.document != nil else { return }
    updateLimits()
    let target = fitScale
    if animated, let sv = scrollView, sv.zoomScale > 0 {
      let factor = target / max(pdfView.scaleFactor, 0.0001)
      sv.setZoomScale(sv.zoomScale * factor, animated: true)
    } else {
      pdfView.scaleFactor = target
      pdfView.autoScales = true
    }
    wasAtFit = true
  }

  func goToPage(_ index: Int, animated: Bool) {
    guard let doc = pdfView.document, index >= 0, index < doc.pageCount, let page = doc.page(at: index) else { return }
    pdfView.go(to: page)
    fit(animated: false)
  }

  private var scrollView: UIScrollView? {
    func find(_ v: UIView) -> UIScrollView? {
      if let s = v as? UIScrollView { return s }
      for sub in v.subviews { if let s = find(sub) { return s } }
      return nil
    }
    return find(pdfView)
  }

  /// Zooms so the point under the finger stays put, like Photos.
  private func zoom(to targetScale: CGFloat, around point: CGPoint) {
    guard let sv = scrollView, let content = sv.delegate?.viewForZooming?(in: sv) else {
      pdfView.scaleFactor = targetScale
      return
    }
    let factor = targetScale / max(pdfView.scaleFactor, 0.0001)
    let newZoom = sv.zoomScale * factor
    let p = pdfView.convert(point, to: content)
    let size = CGSize(width: sv.bounds.width / newZoom, height: sv.bounds.height / newZoom)
    sv.zoom(to: CGRect(x: p.x - size.width / 2, y: p.y - size.height / 2, width: size.width, height: size.height), animated: true)
  }

  @objc private func handleDoubleTap(_ g: UITapGestureRecognizer) {
    guard pdfView.document != nil else { return }
    let base = fitScale
    let feedback = UIImpactFeedbackGenerator(style: .light)
    if pdfView.scaleFactor > base * 1.05 {
      fit(animated: true)
    } else {
      // In close enough to read: 2.5× the fitted view, or real size when that's closer (up to 6×)
      let target = min(pdfView.maxScaleFactor, max(base * 2.5, min(1, base * 6)))
      zoom(to: target, around: g.location(in: pdfView))
      wasAtFit = false
    }
    feedback.impactOccurred(intensity: 0.6)
  }

  @objc private func handleTwoFingerTap(_ g: UITapGestureRecognizer) {
    guard pdfView.document != nil else { return }
    let base = fitScale
    let target = max(base, pdfView.scaleFactor / 2)
    if target <= base * 1.01 {
      fit(animated: true)
    } else {
      zoom(to: target, around: g.location(in: pdfView))
    }
  }

  @objc private func handleSingleTap(_ g: UITapGestureRecognizer) {
    onSingleTap([:])
  }

  @objc private func scaleChanged() {
    pinInsets()
    let rel = pdfView.scaleFactor / fitScale
    wasAtFit = rel < 1.01
    if abs(rel - lastReportedZoom) > 0.005 {
      lastReportedZoom = rel
      onZoomChange(["relative": rel, "scale": pdfView.scaleFactor, "atFit": wasAtFit])
    }
  }

  @objc private func pageChanged() {
    pinInsets()
    guard let doc = pdfView.document, let page = pdfView.currentPage else { return }
    onPageChange(["index": doc.index(for: page), "count": doc.pageCount])
  }

  // Let our taps coexist with PDFView's own recognizers (scrolling, zooming, text selection)
  func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    true
  }
}
