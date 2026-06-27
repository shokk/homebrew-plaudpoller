# Place this file at Formula/plaudpoller.rb in a repo named homebrew-plaud
# (github.com/shokk/homebrew-plaud)
#
# Users install with:
#   brew tap shokk/plaud
#   brew install plaudpoller

class Plaudpoller < Formula
  desc "Poll and download recordings from Plaud.ai"
  homepage "https://github.com/shokk/PlaudPoller"
  version "1.0.7"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/shokk/PlaudPoller/releases/download/v#{version}/plaudpoller-arm64"
      sha256 "42cafd58eae061b40a4950ba4228ee99c60e2f044252a2b138557000ae5eaad0"
    else
      url "https://github.com/shokk/PlaudPoller/releases/download/v#{version}/plaudpoller-x64"
      sha256 "40deb9c26a7b843c5ea33ac8edd282e9c6b773b511794fb8a0ceaa13f0a537c2"
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
