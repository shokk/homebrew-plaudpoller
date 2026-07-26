# Formula/plaudpoller.rb — part of github.com/shokk/homebrew-plaudpoller
#
# Users install with:
#   brew tap shokk/plaudpoller
#   brew install plaudpoller

class Plaudpoller < Formula
  desc "Poll and download recordings from Plaud.ai"
  homepage "https://github.com/shokk/homebrew-plaudpoller"
  version "1.2.8"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/shokk/homebrew-plaudpoller/releases/download/v#{version}/plaudpoller-arm64"
      sha256 "7b6184d7eb8005d64e94fc0b9c39be1c8eae1cfa726ed4d6b45b1cc7b40ff261"
    else
      url "https://github.com/shokk/homebrew-plaudpoller/releases/download/v#{version}/plaudpoller-x64"
      sha256 "839198547a17876508c6693258192daabc5fd759eaa90200e8f15777fbcb7acd"
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
