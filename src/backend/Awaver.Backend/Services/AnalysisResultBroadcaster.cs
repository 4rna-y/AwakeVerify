using System.Collections.Concurrent;
using System.Threading.Channels;

namespace Awaver.Backend.Services;

public sealed class AnalysisResultBroadcaster
{
    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<Guid, Channel<string>>> _subscribers = new();

    public ChannelReader<string> Subscribe(Guid sessionId, out Guid subscriptionId)
    {
        var channel = Channel.CreateUnbounded<string>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
        });

        subscriptionId = Guid.NewGuid();
        var sessionSubscribers = _subscribers.GetOrAdd(sessionId, _ => new ConcurrentDictionary<Guid, Channel<string>>());
        sessionSubscribers[subscriptionId] = channel;
        return channel.Reader;
    }

    public void Unsubscribe(Guid sessionId, Guid subscriptionId)
    {
        if (!_subscribers.TryGetValue(sessionId, out var sessionSubscribers))
        {
            return;
        }

        if (sessionSubscribers.TryRemove(subscriptionId, out var channel))
        {
            channel.Writer.TryComplete();
        }

        if (sessionSubscribers.IsEmpty)
        {
            _subscribers.TryRemove(sessionId, out _);
        }
    }

    public int Publish(Guid sessionId, string json)
    {
        if (!_subscribers.TryGetValue(sessionId, out var sessionSubscribers))
        {
            return 0;
        }

        var delivered = 0;
        foreach (var subscriber in sessionSubscribers.Values)
        {
            if (subscriber.Writer.TryWrite(json))
            {
                delivered++;
            }
        }

        return delivered;
    }
}
