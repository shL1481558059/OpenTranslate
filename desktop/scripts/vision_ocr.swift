import AppKit
import Foundation
import Vision

struct OCRBlock: Codable {
    let id: String
    let text: String
    let lines: [String]
    let bbox: CGRectCodable
}

struct CGRectCodable: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ rect: CGRect) {
        self.x = Double(rect.origin.x)
        self.y = Double(rect.origin.y)
        self.width = Double(rect.width)
        self.height = Double(rect.height)
    }
}

struct OCRResult: Codable {
    let imageWidth: Int
    let imageHeight: Int
    let blocks: [OCRBlock]
}

guard CommandLine.arguments.count > 1 else {
    fputs("{}\n", stderr)
    exit(1)
}

let imagePath = CommandLine.arguments[1]
guard let nsImage = NSImage(contentsOfFile: imagePath) else {
    fputs("{}\n", stderr)
    exit(1)
}

guard
    let tiff = nsImage.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiff),
    let cgImage = bitmap.cgImage
else {
    fputs("{}\n", stderr)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
if #available(macOS 11.0, *) {
    request.automaticallyDetectsLanguage = true
}
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US", "ja-JP", "ko-KR"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fputs("{}\n", stderr)
    exit(1)
}

let observations = request.results ?? []
var blocks: [OCRBlock] = []
blocks.reserveCapacity(observations.count)

for (index, observation) in observations.enumerated() {
    guard let candidate = observation.topCandidates(1).first else {
        continue
    }

    let text = candidate.string
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        continue
    }

    let lines = text.components(separatedBy: "\n")
    let block = OCRBlock(
        id: "b\(index + 1)",
        text: text,
        lines: lines,
        bbox: CGRectCodable(observation.boundingBox)
    )
    blocks.append(block)
}

let result = OCRResult(
    imageWidth: cgImage.width,
    imageHeight: cgImage.height,
    blocks: blocks
)

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
if let data = try? encoder.encode(result), let text = String(data: data, encoding: .utf8) {
    print(text)
} else {
    fputs("{}\n", stderr)
    exit(1)
}
