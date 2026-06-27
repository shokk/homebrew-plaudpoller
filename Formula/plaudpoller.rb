# Place this file at Formula/plaudpoller.rb in a repo named homebrew-plaud
# (github.com/shokk/homebrew-plaud)
#
# Users install with:
#   brew tap shokk/plaud
#   brew install plaudpoller

class Plaudpoller < Formula
  desc "Poll and download recordings from Plaud.ai"
  homepage "https://github.com/shokk/PlaudPoller"
  version "1.0.4"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/shokk/PlaudPoller/releases/download/v#{version}/plaudpoller-arm64"
      sha256 "c90fc0139f7c5cafd3bb821b0e616b43fc51c52f79013e1d0fd3696255c52408"
    else
      url "https://github.com/shokk/PlaudPoller/releases/download/v#{version}/plaudpoller-x64"
      sha256 "788b35259fe6ee8d95fef47d95e79ad1f8f9ff5a91308d12f396b9329b5e0348"
    end
  end

  def install
    binary = Hardware::CPU.arm? ? "plaudpoller-arm64" : "plaudpoller-x64"
    bin.install binary => "plaudpoller"
  end

  test do
    assert_match "Usage: plaudpoller", shell_output("#{bin}/plaudpoller 2>&1", 0)
  end
end
