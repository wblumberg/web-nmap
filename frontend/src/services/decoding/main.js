/*

    Decoders to decode AMBP messages from the API that contain the actual data to be plotted. The decoders are used by the AMBP decoder to decode the data in the message.

*/

export function decodeAMBP(buffer) {

    const view = new DataView(buffer)

    let offset = 0

    const magic = String.fromCharCode(
        view.getUint8(0),
        view.getUint8(1),
        view.getUint8(2),
        view.getUint8(3)
    )

    if (magic !== "AMBP") {
        throw new Error("Invalid AMBP message")
    }

    offset += 4

    const version = view.getUint8(offset); offset++
    const type = view.getUint8(offset); offset++
    const flags = view.getUint8(offset); offset++
    offset++

    const headerLen = view.getUint32(offset, true); offset += 4
    const payloadLen = view.getUint32(offset, true); offset += 4

    const headerStart = offset
    const payloadStart = headerStart + headerLen

    if (type === 1) {
        return decodeGrid(view, headerStart, payloadStart)
    }

    if (type === 2) {
        return decodePoints(view, headerStart, payloadStart)
    }

    if (type === 3) {
        return decodeFeatures(view, headerStart, payloadStart)
    }

    if (type === 4) {
        return decodeContours(view, headerStart, payloadStart)
    }
}