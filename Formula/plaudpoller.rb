# Place this file at Formula/plaudpoller.rb in a repo named homebrew-plaud
# (github.com/shokk/homebrew-plaud)
#
# Users install with:
#   brew tap shokk/plaud
#   brew install plaudpoller

class Plaudpoller < Formula
  desc "Poll and download recordings from Plaud.ai"
  homepage "https://github.com/shokk/PlaudPoller"
  version "1.0.3"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/shokk/PlaudPoller/releases/download/v#{version}/plaudpoller-arm64"
      sha256 "8d39993c0796ee28818df2b4a3d5da74dfa10fdf89d23b9cd370d10dfcb41474"
    else
      url "https://github.com/shokk/PlaudPoller/releases/download/v#{version}/plaudpoller-x64"
      sha256 "18a476ea5bba6fcef433aecebc1ee8c283ae3759e04514ed5c8a9e2d8f97114a"
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
