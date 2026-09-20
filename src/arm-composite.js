// Apply the exact same cover crop and reflection to camera pixels and their mask.
export function coverRect(sourceWidth, sourceHeight, width, height) {
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  return {
    x: (width - sourceWidth * scale) / 2,
    y: (height - sourceHeight * scale) / 2,
    width: sourceWidth * scale,
    height: sourceHeight * scale,
  };
}

export function compositeArms(context, frame, mask, width, height, mirrored) {
  context.clearRect(0, 0, width, height);
  const rect = coverRect(
    frame.videoWidth ?? frame.width,
    frame.videoHeight ?? frame.height,
    width,
    height,
  );
  context.save();
  if (mirrored) {
    context.translate(width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(frame, rect.x, rect.y, rect.width, rect.height);
  context.globalCompositeOperation = 'destination-in';
  context.drawImage(mask, rect.x, rect.y, rect.width, rect.height);
  context.restore();
}
