export function bedrockToastAction(
  tr: (source: string) => string,
  message: string,
) {
  if (/xbox.*(?:profile|binding).*(?:missing|link|bind|refresh)|active xbox account.*xuid|xuid.*(?:missing|link|bind|refresh)/i.test(message)) {
    return {
      label: tr("How to fix"),
      title: tr("Xbox profile needs linking"),
      message: tr("Sign in to Store and Xbox with the Minecraft owner account, then bind it here."),
    };
  }
  if (/full minecraft license|store\/xbox|licensed microsoft account|license.*active/i.test(message)) {
    return {
      label: tr("How to fix"),
      title: tr("Microsoft Store license is required"),
      message: tr("Bedrock uses the Microsoft/Xbox account that owns Minecraft for Windows."),
    };
  }
  if (/account.*match|xbox.*account|account mismatch|xuid/i.test(message)) {
    return {
      label: tr("How to fix"),
      title: tr("The Xbox account does not match"),
      message: tr("Use the same Microsoft/Xbox account that installed this version."),
    };
  }
  if (/gaming services|gameinput/i.test(message)) {
    return {
      label: tr("How to fix"),
      title: tr("Windows gaming components are missing"),
      message: tr("Install or repair Gaming Services and GameInput, then retry."),
    };
  }
  if (/msixvc|xvd|checksum|md5|damaged|corrupt|incomplete/i.test(message)) {
    return {
      label: tr("How to fix"),
      title: tr("The Bedrock package is damaged"),
      message: tr("The downloaded package is damaged. Delete it and retry."),
    };
  }
  if (/x86|32-bit|architecture/i.test(message)) {
    return {
      label: tr("Why?"),
      title: tr("Bedrock requires Windows x64"),
      message: tr("This installer requires 64-bit Windows."),
    };
  }
  if (/cancelled|canceled|отменена/i.test(message)) {
    return {
      label: tr("Retry"),
      title: tr("Bedrock installation was canceled"),
      message: tr("Installation was canceled. Retry when Store and Xbox are ready."),
    };
  }
  if (/developer mode/i.test(message)) {
    return {
      label: tr("Why?"),
      title: tr("Why is Developer Mode needed?"),
      message: tr("Developer Mode allows installation of older Bedrock packages; it does not bypass licensing."),
    };
  }
  if (/store submission|local sideloading|signed for submission|not valid for submission|makepkg/i.test(message)) {
    return {
      label: tr("Why?"),
      title: tr("Why can't this Bedrock package be installed?"),
      message: tr("This package needs SLH's native installer. Update SLH and retry."),
    };
  }
  return undefined;
}

