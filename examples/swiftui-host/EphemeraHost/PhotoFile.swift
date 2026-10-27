import Foundation
import ImageIO
import UniformTypeIdentifiers

/// One picked photo as the pickPhoto reply's `file`: the original bytes (base64), its MIME type, byte size and
/// pixel width/height as displayed (EXIF orientation 5–8 swaps them). No resizing, no re-encoding.
enum PhotoFile {
    struct Failure: Error { let message: String }

    /// The types the page accepts (docs/EMBED.md §5); the first one the item provides is used.
    static let accepted: [UTType] = [.heic, .heif, .jpeg, .png] + [UTType("public.avif")].compactMap { $0 }
    static let maxBytes = 20 * 1024 * 1024

    static func load(from provider: NSItemProvider, done: @escaping (Result<[String: Any], Failure>) -> Void) {
        let offered = provider.registeredTypeIdentifiers.compactMap(UTType.init)
        // a type the page takes as is; otherwise (GIF, TIFF, ...) ask the system for a JPEG rendition
        let type = offered.first(where: accepted.contains)
            ?? offered.first(where: { t in accepted.contains(where: { t.conforms(to: $0) }) })
            ?? UTType.jpeg
        provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, error in
            guard let data else {
                done(.failure(Failure(message: error?.localizedDescription ?? "could not read the photo")))
                return
            }
            if data.count > maxBytes {
                // the page shows its own sentence for this; it needs the size, not the bytes
                done(.failure(Failure(message: "这张照片超过 20MB，换一张小一点的")))
                return
            }
            guard let (w, h) = pixelSize(data) else {
                done(.failure(Failure(message: "这张照片读不出宽高，换一张试试")))
                return
            }
            let ext = type.preferredFilenameExtension ?? "jpg"
            let base = provider.suggestedName ?? "photo"
            done(.success([
                "name": base.hasSuffix(".\(ext)") ? base : "\(base).\(ext)",
                "mime": type.preferredMIMEType ?? "image/jpeg",
                "size": data.count,
                "width": w,
                "height": h,
                "data": data.base64EncodedString(),
            ]))
        }
    }

    static func pixelSize(_ data: Data) -> (Int, Int)? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int,
              w > 0, h > 0 else { return nil }
        let orientation = props[kCGImagePropertyOrientation] as? Int ?? 1
        return orientation >= 5 ? (h, w) : (w, h)
    }
}
