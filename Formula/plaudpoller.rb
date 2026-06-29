# Formula/plaudpoller.rb — part of github.com/shokk/homebrew-plaudpoller
#
# Users install with:
#   brew tap shokk/plaudpoller
#   brew install plaudpoller

class Plaudpoller < Formula
  desc "Poll and download recordings from Plaud.ai"
  homepage "https://github.com/shokk/homebrew-plaudpoller"
  version "1.1.8"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/shokk/homebrew-plaudpoller/releases/download/v#{version}/plaudpoller-arm64"
      sha256 "48eebbffc6cbed264e783d4496848536b0cd8f7fd3820582049d1117ba6848e8"
    else
      url "https://github.com/shokk/homebrew-plaudpoller/releases/download/v#{version}/plaudpoller-x64"
      sha256 "cadff3286c512da85b5db744055b2819717c4c1af7b3d702c8368f6291f25cbc"
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
