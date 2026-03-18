import AppKit
import Foundation
import Vision

struct RectInfo: Codable {
    let id: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let confidence: Double
}

struct RectResult: Codable {
    let imageWidth: Int
    let imageHeight: Int
    let rects: [RectInfo]
}

guard CommandLine.arguments.count > 1 else {
    print("{\"rects\":[]}")
    exit(0)
}

let imagePath = CommandLine.arguments[1]
guard let nsImage = NSImage(contentsOfFile: imagePath) else {
    print("{\"rects\":[]}")
    exit(0)
}

guard
    let tiff = nsImage.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiff),
    let cgImage = bitmap.cgImage
else {
    print("{\"rects\":[]}")
    exit(0)
}

let request = VNDetectRectanglesRequest()
request.maximumObservations = 30
request.minimumSize = 0.1
request.minimumConfidence = 0.5
request.quadratureTolerance = 20

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    print("{\"rects\":[]}")
    exit(0)
}

let observations = request.results ?? []
var rects: [RectInfo] = []
rects.reserveCapacity(observations.count)

for (index, observation) in observations.enumerated() {
    let bbox = observation.boundingBox
    let x = Double(bbox.origin.x) * Double(cgImage.width)
    let y = Double(1.0 - bbox.origin.y - bbox.size.height) * Double(cgImage.height)
    let w = Double(bbox.size.width) * Double(cgImage.width)
    let h = Double(bbox.size.height) * Double(cgImage.height)
    rects.append(
        RectInfo(
            id: "r\(index + 1)",
            x: x,
            y: y,
            width: w,
            height: h,
            confidence: Double(observation.confidence)
        )
    )
}

let result = RectResult(
    imageWidth: cgImage.width,
    imageHeight: cgImage.height,
    rects: rects
)

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
if let data = try? encoder.encode(result), let text = String(data: data, encoding: .utf8) {
    print(text)
} else {
    print("{\"rects\":[]}")
}
