# Place this file at Formula/plaudpoller.rb in a repo named homebrew-plaud
# (github.com/shokk/homebrew-plaud)
#
# Users install with:
#   brew tap shokk/plaud
#   brew install plaudpoller

class Plaudpoller < Formula
  desc "Poll and download recordings from Plaud.ai"
  homepage "https://github.com/shokk/PlaudPoller"
  version "1.0.2"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/shokk/PlaudPoller/releases/download/v#{version}/plaudpoller-arm64"
      sha256 "d9de85860f9971f43aed82ff15d678d79a29a6f98d5a08e5ae64de3e14893742"
    else
      url "https://github.com/shokk/PlaudPoller/releases/download/v#{version}/plaudpoller-x64"
      sha256 "d35ac9d9a843ed7f91a298a4446da0eddb3bc9c298f47716e5b87872e4892aa5"
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
