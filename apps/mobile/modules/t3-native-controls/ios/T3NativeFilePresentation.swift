import AVFoundation
import ImageIO
import QuickLook
import UIKit
import UniformTypeIdentifiers

private final class FilePreviewItem: NSObject, QLPreviewItem {
  var previewItemURL: URL?
  var previewItemTitle: String?
}

private struct PreparedPreviewFile {
  let url: URL
  let image: UIImage?
}

/// UIKit supplies pinch/pan physics, header controls, sharing, and interactive zoom dismissal.
private final class NativeImagePreviewController: UIViewController, UIScrollViewDelegate {
  var usesZoomTransition = false
  private let imageView: UIImageView
  private let scrollView = UIScrollView()
  private let url: URL
  private let onClose: () -> Void
  private let onDismiss: () -> Void
  private var viewportSize = CGSize.zero

  init(image: UIImage, url: URL, title: String, onClose: @escaping () -> Void, onDismiss: @escaping () -> Void) {
    self.imageView = UIImageView(image: image)
    self.url = url
    self.onClose = onClose
    self.onDismiss = onDismiss
    super.init(nibName: nil, bundle: nil)
    self.title = title
  }

  required init?(coder: NSCoder) { nil }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    scrollView.frame = view.bounds
    scrollView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    scrollView.contentInsetAdjustmentBehavior = .never
    scrollView.showsHorizontalScrollIndicator = false
    scrollView.showsVerticalScrollIndicator = false
    scrollView.delegate = self
    scrollView.accessibilityIdentifier = "ImagePreviewScrollView"
    imageView.isAccessibilityElement = true
    imageView.accessibilityLabel = title
    imageView.accessibilityIdentifier = "ImagePreviewImage"
    scrollView.addSubview(imageView)
    view.addSubview(scrollView)

    navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in
      self?.onClose()
    })
    navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .action, target: self, action: #selector(share))
    navigationItem.rightBarButtonItem?.accessibilityLabel = "Share"
    let appearance = UINavigationBarAppearance()
    appearance.configureWithTransparentBackground()
    appearance.titleTextAttributes = [.foregroundColor: UIColor.white]
    navigationItem.standardAppearance = appearance
    navigationItem.scrollEdgeAppearance = appearance
    navigationItem.compactAppearance = appearance
    navigationController?.navigationBar.tintColor = .white

    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(zoom))
    doubleTap.numberOfTapsRequired = 2
    let singleTap = UITapGestureRecognizer(target: self, action: #selector(toggleControls))
    singleTap.require(toFail: doubleTap)
    scrollView.addGestureRecognizer(singleTap)
    scrollView.addGestureRecognizer(doubleTap)
    if !usesZoomTransition {
      let swipe = UISwipeGestureRecognizer(target: self, action: #selector(closeIfNotZoomed))
      swipe.direction = .down
      scrollView.addGestureRecognizer(swipe)
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let size = scrollView.bounds.size
    guard size != viewportSize, let image = imageView.image, size.width > 0, size.height > 0 else { return }
    viewportSize = size
    scrollView.minimumZoomScale = 1
    scrollView.zoomScale = 1
    imageView.frame = CGRect(origin: .zero, size: image.size)
    scrollView.contentSize = image.size
    let fit = min(size.width / image.size.width, size.height / image.size.height)
    scrollView.maximumZoomScale = max(fit * 4, 1)
    scrollView.minimumZoomScale = fit
    scrollView.zoomScale = fit
    centerImage()
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if isBeingDismissed || navigationController?.isBeingDismissed == true || navigationController?.presentingViewController == nil {
      onDismiss()
    }
  }

  func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
  func scrollViewDidZoom(_ scrollView: UIScrollView) { centerImage() }

  private func centerImage() {
    let horizontal = max(0, (scrollView.bounds.width - scrollView.contentSize.width) / 2)
    let vertical = max(0, (scrollView.bounds.height - scrollView.contentSize.height) / 2)
    scrollView.contentInset = UIEdgeInsets(top: vertical, left: horizontal, bottom: vertical, right: horizontal)
  }

  @objc private func zoom(_ recognizer: UITapGestureRecognizer) {
    if scrollView.zoomScale > scrollView.minimumZoomScale * 1.01 {
      scrollView.setZoomScale(scrollView.minimumZoomScale, animated: true)
    } else {
      let scale = min(scrollView.minimumZoomScale * 3, scrollView.maximumZoomScale)
      let point = recognizer.location(in: imageView)
      let size = CGSize(width: scrollView.bounds.width / scale, height: scrollView.bounds.height / scale)
      let rect = CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height)
      scrollView.zoom(to: rect, animated: true)
    }
  }

  @objc private func toggleControls() {
    guard let navigationController else { return }
    navigationController.setNavigationBarHidden(!navigationController.isNavigationBarHidden, animated: true)
  }

  @objc private func closeIfNotZoomed() {
    if scrollView.zoomScale <= scrollView.minimumZoomScale * 1.01 { onClose() }
  }

  @objc private func share(_ sender: UIBarButtonItem) {
    let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
    sheet.popoverPresentationController?.barButtonItem = sender
    present(sheet, animated: true)
  }
}

/// Shares file preparation and lifecycle between the image viewer and Quick Look documents.
final class T3NativeFilePresentation: NSObject, QLPreviewControllerDataSource,
  QLPreviewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  let identifier: String
  private var controller: UIViewController?
  private let completion: (Error?) -> Void
  private weak var sources: T3PresentationSources?
  private let sourceIdentifier: String
  private let item = FilePreviewItem()
  private var loading: Task<Void, Never>?
  private var presented = false
  private var dismissRequested = false
  private var finished = false

  init(identifier: String, sources: T3PresentationSources, sourceIdentifier: String, completion: @escaping (Error?) -> Void) {
    self.identifier = identifier
    self.sources = sources
    self.sourceIdentifier = sourceIdentifier
    self.completion = completion
    super.init()
  }

  func present(url: URL, title: String, from presenter: UIViewController) {
    loading = Task { @MainActor [self] in
      do {
        let file = try await Self.prepareFile(url: url, title: title)
        guard !finished, !Task.isCancelled else {
          try? FileManager.default.removeItem(at: file.url.deletingLastPathComponent())
          return
        }
        item.previewItemURL = file.url
        item.previewItemTitle = title
        let preview: UIViewController
        if let image = file.image {
          let viewer = NativeImagePreviewController(
            image: image, url: file.url, title: title,
            onClose: { [weak self] in self?.dismiss() }, onDismiss: { [weak self] in self?.finish() }
          )
          let navigation = UINavigationController(rootViewController: viewer)
          navigation.modalPresentationStyle = .fullScreen
          navigation.overrideUserInterfaceStyle = .dark
          preview = navigation
          if #available(iOS 18.0, *), !UIAccessibility.isReduceMotionEnabled,
            sources?.view(for: sourceIdentifier)?.window != nil {
            viewer.usesZoomTransition = true
            let options = UIViewController.Transition.ZoomOptions()
            options.alignmentRectProvider = { context in
              AVMakeRect(aspectRatio: image.size, insideRect: context.zoomedViewController.view.bounds)
            }
            preview.preferredTransition = .zoom(options: options) { [weak self] _ in
              guard let self, let source = sources?.view(for: sourceIdentifier), source.window != nil else { return nil }
              return source
            }
          }
          navigation.view.backgroundColor = .black
        } else {
          let quickLook = QLPreviewController()
          quickLook.delegate = self
          quickLook.dataSource = self
          preview = quickLook
        }
        controller = preview
        presenter.present(preview, animated: !UIAccessibility.isReduceMotionEnabled) { [self] in
          presented = true
          if dismissRequested { dismiss() }
        }
        preview.presentationController?.delegate = self
      } catch {
        finish(error: error)
      }
    }
  }

  func dismiss() {
    dismissRequested = true
    loading?.cancel()
    guard !finished else { return }
    guard presented else {
      if controller?.presentingViewController == nil { finish() }
      return
    }
    controller?.dismiss(animated: !UIAccessibility.isReduceMotionEnabled) { [self] in finish() }
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { item.previewItemURL == nil ? 0 : 1 }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    item
  }

  func previewControllerDidDismiss(_ controller: QLPreviewController) { finish() }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish() }

  private func finish(error: Error? = nil) {
    guard !finished else { return }
    finished = true
    loading?.cancel()
    loading = nil
    if let file = item.previewItemURL {
      try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }
    item.previewItemURL = nil
    completion(error)
  }

  /// Copy original bytes so preview and sharing do not mutate a draft or workspace file.
  nonisolated private static func prepareFile(url: URL, title: String) async throws -> PreparedPreviewFile {
    try Task.checkCancellation()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("t3-preview-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    do {
      let download = directory.appendingPathComponent("original")
      if url.isFileURL {
        try FileManager.default.copyItem(at: url, to: download)
      } else if url.scheme == "data" {
        try Data(contentsOf: url).write(to: download, options: .atomic)
      } else {
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? "") else {
          throw URLError(.unsupportedURL)
        }
        let (temporaryFile, response) = try await URLSession.shared.download(from: url)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
          throw URLError(.badServerResponse)
        }
        try FileManager.default.moveItem(at: temporaryFile, to: download)
      }
      try Task.checkCancellation()
      let type: UTType
      var previewImage: UIImage?
      if let image = CGImageSourceCreateWithURL(download as CFURL, nil),
        CGImageSourceGetCount(image) > 0, let imageType = CGImageSourceGetType(image),
        let detectedType = UTType(imageType as String) {
        type = detectedType
        // Animated images stay in Quick Look; static images are decoded before the zoom starts.
        if CGImageSourceGetCount(image) == 1 {
          previewImage = UIImage(contentsOfFile: download.path)?.preparingForDisplay()
        }
      } else if CGPDFDocument(download as CFURL) != nil {
        type = .pdf
      } else {
        throw URLError(.cannotDecodeContentData)
      }
      let filename = URL(fileURLWithPath: title).lastPathComponent as NSString
      let originalExtension = filename.pathExtension
      let fileExtension = UTType(filenameExtension: originalExtension) == type
        ? originalExtension : type.preferredFilenameExtension ?? "png"
      let stem = filename.deletingPathExtension
      var name = String(stem.prefix(60)).components(separatedBy: .controlCharacters).joined(separator: "_")
      while name.utf8.count > 200 { name.removeLast() }
      let file = directory.appendingPathComponent("\(name.isEmpty ? "Preview" : name).\(fileExtension)")
      try FileManager.default.moveItem(at: download, to: file)
      return PreparedPreviewFile(url: file, image: previewImage)
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
  }
}
