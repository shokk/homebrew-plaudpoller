# Place this file at Formula/plaud.rb in a repo named homebrew-plaud
# (github.com/eoporto/homebrew-plaud)
#
# Users install with:
#   brew tap eoporto/plaud
#   brew install plaud

class Plaud < Formula
  desc "Poll and download recordings from Plaud.ai"
  homepage "https://github.com/eoporto/PlaudPoller"
  version "1.0.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/eoporto/PlaudPoller/releases/download/v#{version}/plaud-arm64"
      sha256 "PLACEHOLDER_ARM64_SHA256"
    else
      url "https://github.com/eoporto/PlaudPoller/releases/download/v#{version}/plaud-x64"
      sha256 "PLACEHOLDER_X64_SHA256"
    end
  end

  def install
    binary = Hardware::CPU.arm? ? "plaud-arm64" : "plaud-x64"
    bin.install binary => "plaud"
  end

  test do
    assert_match "Usage: plaud", shell_output("#{bin}/plaud 2>&1", 0)
  end
end
