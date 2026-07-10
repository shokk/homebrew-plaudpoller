# Formula/plaudpoller.rb — part of github.com/shokk/homebrew-plaudpoller
#
# Users install with:
#   brew tap shokk/plaudpoller
#   brew install plaudpoller

class Plaudpoller < Formula
  desc "Poll and download recordings from Plaud.ai"
  homepage "https://github.com/shokk/homebrew-plaudpoller"
  version "1.2.5"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/shokk/homebrew-plaudpoller/releases/download/v#{version}/plaudpoller-arm64"
      sha256 "269019b9b64c1920a7f4aceec497c756903ac4ba87cc759d490a108dd5b4fbae"
    else
      url "https://github.com/shokk/homebrew-plaudpoller/releases/download/v#{version}/plaudpoller-x64"
      sha256 "3d0803d69bd41cda66e33dd8057f8a2b6ceba2f01cf447f8d3362bca00aaf0ff"
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
