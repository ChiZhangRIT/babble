// 将确认后的 SVG 图标导出成各项目需要的 PNG 尺寸；只做资源输出，不修改设计。
import AppKit
import Foundation

guard CommandLine.arguments.count >= 4,
      let source = NSImage(contentsOfFile: CommandLine.arguments[1]) else { fatalError("Usage: export.swift icon.svg output-directory size...") }
let directory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
for argument in CommandLine.arguments.dropFirst(3) {
    guard let size = Int(argument), size > 0,
          let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: bitmap) else { fatalError("Invalid output size") }
    bitmap.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    source.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("PNG export failed") }
    try png.write(to: directory.appendingPathComponent("icon-\(size).png"))
}
