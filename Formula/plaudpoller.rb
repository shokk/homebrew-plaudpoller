# Formula/plaudpoller.rb — part of github.com/shokk/homebrew-plaudpoller
#
# Users install with:
#   brew tap shokk/plaudpoller
#   brew install plaudpoller

class Plaudpoller < Formula
  desc "Poll and download recordings from Plaud.ai"
  homepage "https://github.com/shokk/homebrew-plaudpoller"
  version "1.3.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/shokk/homebrew-plaudpoller/releases/download/v#{version}/plaudpoller-arm64"
      sha256 "5b3392ef3606717067d3ab21e22feefbbb9401b64bb93db9809f880453489050"
    else
      url "https://github.com/shokk/homebrew-plaudpoller/releases/download/v#{version}/plaudpoller-x64"
      sha256 "40f9c6bfaf0dbf7d3693baf9e3b3f340b598b53193882fa8b607dea1ca06a244"
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
